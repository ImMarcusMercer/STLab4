import 'dotenv/config';
import assert from 'node:assert/strict';
import { readConfig } from '../source/api/config';
import { createDatabase } from '../source/api/database';
import { migrateDatabase } from '../database/migrate';
import { buildApp } from '../source/api/app';

const config = readConfig(process.env);
await migrateDatabase(config.DATABASE_URL);
const database = createDatabase(config.DATABASE_URL);
const app = buildApp({ checkDatabase: database.check });
try {
  await database.check();
  const before = await database.pool.query('SELECT * FROM application_metadata ORDER BY key');
  await migrateDatabase(config.DATABASE_URL);
  const after = await database.pool.query('SELECT * FROM application_metadata ORDER BY key');
  assert.deepEqual(after.rows, before.rows, 'Rerunning migrations must preserve data.');
  assert.equal(after.rows.length, 1);
  const response = await app.inject('/api/v1/system/status');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().database, 'connected');
  console.log('PASS: PostgreSQL connection, migration, repeat migration preserves data, API readiness.');
} finally {
  await app.close();
  await database.close();
}
