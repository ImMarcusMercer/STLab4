import 'dotenv/config';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readConfig } from '../source/api/config';
import { createDatabase } from '../source/api/database';
import { seedDemoDataset } from '../database/seed-demo';

/**
 * Phase 10: writes the laboratory's minimum demonstration dataset into the development
 * database, then checks it against section 8 of the activity and exits non-zero when a
 * minimum is not met. See docs/DEMO_DATASET.md for what the dataset contains and how the
 * demonstration walks through it.
 *
 * The demonstration staff password is generated here and appended to the ignored local
 * configuration, exactly like the bootstrap owner password: it is never committed, never typed
 * into a document and never reused for a real account.
 */
if (!existsSync('.env')) throw new Error('Create the local .env with db:setup first.');
const config = readConfig(process.env);
if (/(^|[_-])test([_-]|$)/i.test(new URL(config.DATABASE_URL).pathname) && process.env.BCIS_ALLOW_TEST_DEMO !== '1') {
  throw new Error('This refuses to seed a database whose name looks like a test database. Set BCIS_ALLOW_TEST_DEMO=1 if that is really what you want.');
}
let password = process.env.DEMO_PASSWORD;
if (!password) {
  password = `Demo-${randomBytes(9).toString('base64url')}-${randomBytes(6).toString('base64url')}`;
  appendFileSync('.env', `\nDEMO_PASSWORD=${password}\n`);
  writeFileSync('.local/demo-credentials.txt',
    `BCIS demonstration accounts\n\nusername: demo-admin, demo-cashier, demo-supervisor, demo-auditor, demo-viewer, demo-technician\npassword: ${password}\n\nSynthetic laboratory data only. Delete this file before any submission.\n`);
}
const ownerUsername = process.env.BOOTSTRAP_ADMIN_USERNAME ?? 'owner';
const ownerPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (!ownerPassword) throw new Error('BOOTSTRAP_ADMIN_PASSWORD is missing from the local .env. Run npm run db:seed first.');

const database = createDatabase(config.DATABASE_URL);
try {
  const started = Date.now();
  const result = await seedDemoDataset({
    pool: database.pool,
    ownerUsername,
    ownerPassword,
    password,
    subscribers: Number(process.env.DEMO_SUBSCRIBERS ?? 50),
    log: message => console.log(`  ${message}`),
  });
  const width = Math.max(...result.rows.map(row => row.label.length));
  console.log('');
  for (const row of result.rows) {
    console.log(`  ${row.met ? 'OK  ' : 'MISS'} ${row.label.padEnd(width)}  ${String(row.actual).padStart(6)}  (minimum ${row.minimum})`);
  }
  console.log('');
  console.log(`  ${result.counts.invoices} invoices, ${result.counts.receipts} receipts and ${result.counts.auditEntries} audit entries were written through the API in ${Math.round((Date.now() - started) / 1000)}s.`);
  console.log(`  Demonstration password: DEMO_PASSWORD in the local .env (also written to .local/demo-credentials.txt).`);
  if (result.unmet.length) {
    console.error('');
    console.error('FAIL: the demonstration dataset does not meet the laboratory minimums:');
    for (const item of result.unmet) console.error(`  - ${item}`);
    process.exitCode = 1;
  } else {
    console.log('');
    console.log('PASS: the demonstration dataset meets every minimum in section 8 of the laboratory.');
  }
} finally {
  await database.close();
}