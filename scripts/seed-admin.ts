import 'dotenv/config';
import { appendFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readConfig } from '../source/api/config';
import { createDatabase } from '../source/api/database';
import { seedSecurity } from '../database/seed-security';
import { Username } from '../source/shared/auth';

if (!existsSync('.env')) throw new Error('Create the local .env with db:setup first.');
let password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const username = Username.parse(process.env.BOOTSTRAP_ADMIN_USERNAME ?? 'owner');
if (!password) {
  password = randomBytes(24).toString('hex');
  appendFileSync('.env', `\nBOOTSTRAP_ADMIN_USERNAME=${username}\nBOOTSTRAP_ADMIN_PASSWORD=${password}\n`);
}
const database = createDatabase(readConfig(process.env).DATABASE_URL);
try {
  await seedSecurity(database.pool, { username, displayName: 'BCIS Owner', password });
  console.log('Role permissions and initial owner are ready. Read BOOTSTRAP_ADMIN_USERNAME/PASSWORD from the local .env. Existing accounts were preserved.');
} finally { await database.close(); }
