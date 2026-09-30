import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { applicationMetadata } from '../../database/schema';

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 2_000, statement_timeout: 2_000 });
  // Pool idle errors must not terminate the API; readiness exposes the outage.
  pool.on('error', () => { console.error('PostgreSQL connection interrupted.'); });
  const db = drizzle(pool);
  return {
    db,
    pool,
    async check() {
      const rows = await db.select({ value: applicationMetadata.value }).from(applicationMetadata)
        .where(eq(applicationMetadata.key, 'schema_version'));
      if (rows[0]?.value !== '3') throw new Error('Required database migrations are missing.');
    },
    close: () => pool.end(),
  };
}
