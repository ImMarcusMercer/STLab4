import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { localDatabaseUrl } from '../../scripts/local-database-config.mjs';
import { migrateDatabase } from '../../database/migrate';
import { readWideNumbersAsNumbers } from '../../source/api/database';

readWideNumbersAsNumbers();

export async function createTestDatabase() {
  const base = localDatabaseUrl(process.env.DATABASE_URL ?? '');
  const name = `bcis_test_${randomBytes(8).toString('hex')}`;
  const adminUrl = new URL(base); adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.href });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(base); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.href });
  const close = async () => {
    await pool.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  };
  /**
   * Ends every connection but leaves the database in place, for a test that needs to look at it
   * afterwards. Without the `end` calls the process would hold a connection open and never exit.
   */
  const keep = async () => { await pool.end(); await admin.end(); };
  try { await migrateDatabase(url.href); }
  catch (error) { await close(); throw error; }
  return { pool, url: url.href, close, keep, name };
}
