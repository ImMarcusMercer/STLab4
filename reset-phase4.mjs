import { readFileSync } from 'node:fs';
import pg from 'pg';

// One-off development reset for the still-unreleased Phase 4 migration. Drops the
// billing objects and the matching migrator journal row so migration 0003 can be
// regenerated while it is still under development.
const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).filter((line) => line.includes('=') && !line.startsWith('#')).map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const phase3LastApplied = 1790604868031;
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
try {
  await pool.query('DROP TABLE IF EXISTS ledger_entries, adjustments, invoice_items, invoices, billing_runs, document_sequences, billing_cycles CASCADE');
  for (const name of ['bcis_guard_append_only', 'bcis_guard_invoice_items', 'bcis_guard_invoice_identity', 'bcis_guard_ledger_entry']) {
    await pool.query(`DROP FUNCTION IF EXISTS ${name}() CASCADE`);
  }
  const removed = await pool.query('DELETE FROM __drizzle_migrations WHERE created_at > $1', [phase3LastApplied]);
  console.log('Removed migrator rows:', removed.rowCount);
} finally { await pool.end(); }
