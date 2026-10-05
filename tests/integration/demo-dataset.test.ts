import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSecurity } from '../../database/seed-security';
import { DEMO_PREFIX, demoRequirements, seedDemoDataset, type DemoSeedResult } from '../../database/seed-demo';
import { createTestDatabase } from '../helpers/database';

/**
 * Phase 10: the demonstration dataset.
 *
 * The laboratory's section 8 asks for a minimum dataset, and a claim that it exists is only
 * worth something if it is produced the same way every time and checked by something other
 * than the seed's own arithmetic. This suite runs the seed against a throwaway PostgreSQL
 * database, then reads the result back through the API and through the rows.
 *
 * The financial assertions are the point. A dataset that merely *contains* rows would be easy
 * to fake with inserts; this one is required to add up. For every subscriber: what was billed
 * is what was paid plus what is open, what was paid is what the standing allocations say, what
 * was received is what was allocated plus the credit still held, and the ledger's net balance
 * is the open balance less that credit. The ledger's stored running balance must also equal the
 * balance recomputed from its own entries.
 */
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let result: DemoSeedResult;
const password = 'Synthetic-Demo-Password-123!';

/** Counts and sums are asked of the database itself, never of the seed's own bookkeeping. */
const number = async (sql: string, values: unknown[] = []) => {
  const row = (await db.pool.query(sql, values)).rows[0] as Record<string, string> | undefined;
  if (!row) throw new Error(`Expected exactly one row from: ${sql}`);
  return Number(Object.values(row)[0]);
};

beforeAll(async () => {
  // Proofs are attachments on disk, so the suite writes them to a temporary directory rather
  // than into the machine's real proof folder.
  process.env.BCIS_PROOF_DIR = await mkdtemp(join(tmpdir(), 'bcis-demo-'));
  db = await createTestDatabase();
  await seedSecurity(db.pool, { username: 'owner', displayName: 'Demo Owner', password });
  result = await seedDemoDataset({
    pool: db.pool,
    ownerUsername: 'owner',
    ownerPassword: password,
    password,
    subscribers: Number(process.env.DEMO_TEST_SUBSCRIBERS ?? 50),
  });
}, 900_000);

afterAll(async () => {
  await db?.close();
  if (process.env.BCIS_PROOF_DIR) await rm(process.env.BCIS_PROOF_DIR, { recursive: true, force: true });
});

describe('the demonstration dataset', () => {
  it('meets every minimum in section 8 of the laboratory', () => {
    expect(result.unmet).toEqual([]);
    for (const row of result.rows) {
      expect(row.met, `${row.label}: ${row.actual} of at least ${row.minimum}`).toBe(true);
    }
    // The minimums are asserted here as well, so a later edit cannot quietly lower the bar.
    expect(Object.fromEntries(demoRequirements.map(row => [row.key, row.minimum]))).toEqual({
      staffUsers: 5, internetPlans: 3, cablePlans: 2, comboPlans: 2, subscribers: 50, serviceAccounts: 60,
      serviceTypes: 3, collectors: 2, areas: 3, billingMonths: 3, cashPayments: 1, gcashPayments: 1,
      partialPayments: 1, advancePayments: 1, overdueAccounts: 10, agingBuckets: 3, reversedPayments: 1,
      voidedPayments: 1, collectionBatches: 1, suspensions: 2,
    });
  });

  it('is synthetic, and every record says so', async () => {
    const unprefixed = await number('SELECT count(*)::text AS count FROM subscribers WHERE code NOT LIKE $1', [`${DEMO_PREFIX}%`]);
    expect(unprefixed).toBe(0);
    const unmarked = await number("SELECT count(*)::text AS count FROM subscribers WHERE notes NOT LIKE '%demonstration%'");
    expect(unmarked).toBe(0);
    // Nothing that could reach a real person: the e-mail domain is reserved by RFC 2606.
    const external = await number("SELECT count(*)::text AS count FROM subscribers WHERE email<>'' AND email NOT LIKE '%@bcis.invalid'");
    expect(external).toBe(0);
    // The GCash references are obviously the demonstration's own.
    const references = await number("SELECT count(*)::text AS count FROM payments WHERE reference_number IS NOT NULL AND reference_number NOT LIKE 'GC-DEMO-%'");
    expect(references).toBe(0);
  });

  it('adds up for every subscriber: billed = paid + open, paid = allocated, received = allocated + credit', async () => {
    const violations = await number(`
      WITH per_subscriber AS (
        SELECT s.id,
          coalesce((SELECT sum(i.total_centavos)  FROM invoices i WHERE i.subscriber_id=s.id AND i.status<>'VOID'),0) AS billed,
          coalesce((SELECT sum(i.paid_centavos)   FROM invoices i WHERE i.subscriber_id=s.id AND i.status<>'VOID'),0) AS paid,
          coalesce((SELECT sum(i.balance_centavos) FROM invoices i WHERE i.subscriber_id=s.id AND i.status IN ('UNPAID','PARTIALLY_PAID','OVERDUE')),0) AS open,
          coalesce((SELECT sum(a.amount_centavos) FROM payment_allocations a JOIN invoices i ON i.id=a.invoice_id
                    WHERE i.subscriber_id=s.id AND a.reversed_at IS NULL),0) AS allocated,
          coalesce((SELECT sum(p.amount_centavos) FROM payments p WHERE p.subscriber_id=s.id AND p.status='POSTED' AND p.direction='PAYMENT'),0) AS received,
          coalesce((SELECT sum(g.amount_centavos - g.applied) FROM (
                      SELECT p.amount_centavos,
                        coalesce((SELECT sum(a.amount_centavos) FROM payment_allocations a WHERE a.payment_id=p.id AND a.reversed_at IS NULL),0) AS applied
                      FROM payments p WHERE p.subscriber_id=s.id AND p.status='POSTED' AND p.direction='PAYMENT') g),0) AS credit,
          coalesce((SELECT sum(l.debit_centavos - l.credit_centavos) FROM ledger_entries l WHERE l.subscriber_id=s.id),0) AS ledger
        FROM subscribers s)
      SELECT count(*)::text AS count FROM per_subscriber
      WHERE billed<>paid+open OR paid<>allocated OR received<>allocated+credit OR ledger<>open-credit`);
    expect(violations).toBe(0);
  });

  it('reproduces every stored ledger balance from its own entries', async () => {
    const mismatched = await number(`
      WITH running AS (
        SELECT subscriber_id, id, entry_no,
          sum(debit_centavos - credit_centavos) OVER (PARTITION BY subscriber_id ORDER BY entry_date,entry_no,id ROWS UNBOUNDED PRECEDING) AS derived,
          balance_centavos AS stored
        FROM ledger_entries)
      SELECT count(*)::text AS count FROM running WHERE derived<>stored`);
    expect(mismatched).toBe(0);
  });

  it('never lets an unconfirmed GCash claim touch a balance', async () => {
    const pending = await number("SELECT count(*)::text AS count FROM payments WHERE status='PENDING'");
    expect(pending).toBeGreaterThanOrEqual(1);
    // A reversed payment keeps its old allocation rows as history, so only the allocations
    // that still stand are checked, and none of those may belong to money that was never posted.
    const allocations = await number(
      "SELECT count(*)::text AS count FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE p.status<>'POSTED' AND a.reversed_at IS NULL",
    );
    expect(allocations).toBe(0);
    const numbered = await number("SELECT count(*)::text AS count FROM payments WHERE receipt_number IS NOT NULL AND status='PENDING'");
    expect(numbered).toBe(0);
  });

  it('issues unique, gap-free receipt numbers per year', async () => {
    const issued = await number('SELECT count(DISTINCT receipt_number)::text AS total FROM payments WHERE receipt_number IS NOT NULL');
    const rows = await number('SELECT count(*)::text AS total FROM payments WHERE receipt_number IS NOT NULL');
    expect(issued).toBe(rows);
    expect(issued).toBeGreaterThan(0);
    const years = (await db.pool.query<{ year: string }>("SELECT DISTINCT substr(receipt_number,5,4) AS year FROM payments WHERE receipt_number LIKE 'RCT-%'")).rows;
    expect(years.length).toBeGreaterThan(0);
    for (const { year } of years) {
      const values = (await db.pool.query<{ value: number }>(
        "SELECT right(receipt_number,4)::int AS value FROM payments WHERE receipt_number LIKE $1 ORDER BY value", [`RCT-${year}-%`],
      )).rows.map(row => row.value);
      // One run of numbers per year with nothing missing and nothing repeated: the office's
      // counter starts at 1001 and steps by one for every receipt it issues.
      const first = values[0] ?? 0;
      expect(first, `first receipt in ${year}`).toBeGreaterThanOrEqual(1001);
      for (const [index, value] of values.entries()) {
        expect(value, `receipt number gap in ${year}`).toBe(first + index);
      }
    }
  });

  it('leaves a disconnected account and a reconnected one for the register to show', async () => {
    const suspended = await number("SELECT count(*)::text AS count FROM service_accounts WHERE status='SUSPENDED'");
    expect(suspended).toBeGreaterThanOrEqual(1);
    const reconnections = await number("SELECT count(*)::text AS count FROM reconnections WHERE status='COMPLETED'");
    expect(reconnections).toBeGreaterThanOrEqual(1);
    // The whole trail is kept: only completing the work restores the line, and the events
    // stay in the append-only history rather than being recalculated onto the account.
    const events = await number("SELECT count(*)::text AS count FROM master_history WHERE resource='services' AND snapshot->>'controlEvent' IS NOT NULL");
    expect(events).toBeGreaterThanOrEqual(4);
  });

  it('refuses to seed a second time over posted history', async () => {
    await expect(seedDemoDataset({ pool: db.pool, ownerUsername: 'owner', ownerPassword: password, password }))
      .rejects.toThrow(/already present/);
  });
});