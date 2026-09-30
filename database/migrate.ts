import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from '../source/api/database';
import { readConfig } from '../source/api/config';

export async function migrateDatabase(connectionString: string) {
  const database = createDatabase(connectionString);
  try {
    await migrate(database.db, { migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)) });
  } finally { await database.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await migrateDatabase(readConfig(process.env).DATABASE_URL);
    console.log('Database migrations applied.');
  } catch {
    console.error('Migration failed. Check PostgreSQL, DATABASE_URL and migration files.');
    process.exitCode = 1;
  }
}
