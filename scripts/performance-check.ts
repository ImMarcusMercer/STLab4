import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import { buildApp } from '../source/api/app';
import { AuthService } from '../source/api/auth/service';
import { seedSecurity } from '../database/seed-security';
import { createTestDatabase } from '../tests/helpers/database';

/**
 * Phase 9: the data-volume check.
 *
 * The other suites prove the system is correct on two accounts. This one asks whether it is
 * still usable at the size an ISP actually runs at, by building a synthetic office of
 * 20,000 subscribers (BCIS_VOLUME to change it), then timing the screens a collector, a
 * cashier and the owner use, and checking that the plans PostgreSQL chose are index plans
 * rather than full-table scans.
 *
 * Every row is synthetic and is written to a throwaway database that is dropped at the end,
 * so nothing here can reach the demonstration data. Nothing is mocked: the measurements go
 * through the same Fastify routes, services, SQL and Zod contracts the desktop calls.
 *
 * Run it with `npm run test:performance`. It is kept out of `npm test` and `npm run
 * test:integration` because it writes hundreds of thousands of rows and takes minutes; it is
 * a review tool, not a gate on every save.
 */
const VOLUME = Number(process.env.BCIS_VOLUME ?? 20_000);
const MONTHS = Number(process.env.BCIS_MONTHS ?? 6);
const RUNS = Number(process.env.BCIS_RUNS ?? 3);
/** The size the review is made at, and below which a scan is honestly the cheaper plan. */
const REVIEW_VOLUME = 20_000;
/** A budget in milliseconds, stated per screen rather than as one global target. */
const BUDGETS: Record<string, number> = {
  'subscriber list': 1_500,
  'subscriber search': 1_500,
  'service list': 1_500,
  'payments list': 1_500,
  'payment account panel': 1_500,
  'subscriber statement': 2_000,
  'receivables summary': 10_000,
  'overdue worklist': 15_000,
  'aging report': 10_000,
  'billing versus collection': 10_000,
  'revenue report': 10_000,
  'subscriber master report': 15_000,
  'collector performance': 5_000,
  'payment exceptions': 5_000,
  'audit trail report': 10_000,
  'collections summary': 10_000,
  'dashboard': 10_000,
  'record payment': 5_000,
  'open collection route': 10_000,
};

/** The budget for a screen, or a loud failure rather than an unlimited one. */
const budget = (name: string) => {
  const value = BUDGETS[name];
  if (value === undefined) throw new Error(`No budget is set for "${name}".`);
  return value;
};
/** The first row of a fixture query, as a value rather than as possibly undefined. */
const first = <T>(rows: T[]) => {
  const row = rows[0];
  if (row === undefined) throw new Error('Expected at least one row from the fixture query.');
  return row;
};

const results: { name: string; median: number; budget: number; rows: number | string; samples: number | string }[] = [];
const failures: string[] = [];

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;

async function main() {
  console.log(`BCIS volume check: ${VOLUME.toLocaleString('en-PH')} subscribers, ${MONTHS} billing months.`);
  const database = await createTestDatabase();
  console.log(`Database ${database.url.replace(/:[^:@/]+@/, ':[redacted]@')}`);
  try {
    const password = 'Synthetic-Volume-Password-123!';
    await seedSecurity(database.pool, { username: 'owner', displayName: 'Volume Owner', password });
    const auth = new AuthService(database.pool);
    const owner = (await auth.login('owner', password)).token;

    console.log('Seeding synthetic data...');
    const seedStart = performance.now();
    await seed(database.pool);
    console.log(`  seeded and analysed in ${Math.round(performance.now() - seedStart)} ms`);
    for (const table of ['subscribers', 'service_accounts', 'invoices', 'invoice_items', 'payments', 'payment_allocations', 'ledger_entries']) {
      const counted = await database.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      console.log(`  ${table.padEnd(20)} ${Number(first(counted.rows).count).toLocaleString('en-PH')}`);
    }

    const app = buildApp({ checkDatabase: async () => undefined, auth, logLevel: 'silent' });
    try {
      await measureApi(app, owner, database);
      printTimings();
      await measurePlans(database);
      await measureCorrectness(app, owner, database);
    } finally { await app.close(); }
  } finally {
    // The connections are ended either way: a kept database is only kept for inspection, and a
    // process that still holds a connection never exits.
    if (process.env.BCIS_KEEP === '1') {
      await database.keep();
      console.log(`Kept ${database.url}`);
    } else {
      await database.close();
    }
  }

  if (failures.length) {
    console.log('');
    console.log('FAIL:');
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('');
  console.log(`PASS: ${results.length} screens within budget on ${VOLUME.toLocaleString('en-PH')} subscribers, index plans confirmed.`);
}

/** The timings, in the order the screens were measured. */
function printTimings() {
  console.log('');
  console.log(`Screen timings in milliseconds, median of ${RUNS} runs, writes measured once`);
  console.log('  ' + 'screen'.padEnd(32) + 'time'.padStart(9) + 'budget'.padStart(9) + '     rows');
  for (const result of results) {
    const verdict = result.median <= result.budget ? 'PASS' : 'FAIL';
    console.log(
      '  ' + result.name.padEnd(32) + String(Math.round(result.median)).padStart(9)
      + String(result.budget).padStart(9) + `   ${String(result.rows).padStart(8)}  ${verdict}`,
    );
  }
}

/**
 * The synthetic office.
 *
 * Written in one transaction with `generate_series` rather than row by row, because seeding
 * 20,000 subscribers through the API would take minutes and would test the write path instead
 * of the read path this review is about. The shape is what the application itself would have
 * produced: a billed month per account for each cycle, a fifth of the invoices settled, a
 * fifth of those only partly, an invoice line each, a cash receipt and an allocation for every
 * settled invoice, and a debit and credit line in the ledger for each of them.
 */
async function seed(pool: Awaited<ReturnType<typeof createTestDatabase>>['pool']) {
  const owner = await pool.query<{ id: string }>("SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE r.role_code='OWNER' LIMIT 1");
  const ownerId = first(owner.rows).id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL synchronous_commit = off');
    await client.query(
      `INSERT INTO service_plans(code,name,service_type,price_centavos,installation_fee_centavos,reconnection_fee_centavos,description,speed_mbps,active)
       VALUES('PERF999','Volume Internet 999','INTERNET',99900,100000,10000,'Synthetic plan for the data-volume check.',100,true)`,
    );
    await client.query(
      `INSERT INTO collection_areas(code,name,description) SELECT 'AREA'||lpad(n::text,3,'0'),'Volume Area '||n,'' FROM generate_series(1,20) n`,
    );
    await client.query(
      `INSERT INTO collectors(code,name,contact,notes) SELECT 'COLL'||lpad(n::text,3,'0'),'Volume Collector '||n,'0918'||lpad(n::text,7,'0'),'' FROM generate_series(1,20) n`,
    );
    await client.query(
      `INSERT INTO subscribers(code,name,contact,email,addresses,area_id,collector_id,billing_day,due_day,status,notes)
       SELECT 'SUB-'||lpad(n::text,6,'0'),'Volume Subscriber '||lpad(n::text,6,'0'),'0918'||lpad(((n*7919)%10000000000)::text,10,'0'),
         'volume'||n||'@example.invalid',
         jsonb_build_array('Synthetic Street '||n||', Barangay '||(((n-1)%20)+1)||', Volume City', 'Alternate Street '||n||', Volume City'),
         a.id,c.id,(n%28)+1,(n%15)+3,'ACTIVE',''
       FROM generate_series(1,$1) n
       JOIN collection_areas a ON a.code='AREA'||lpad((((n-1)%20)+1)::text,3,'0')
       JOIN collectors c ON c.code='COLL'||lpad((((n-1)%20)+1)::text,3,'0')`,
      [VOLUME],
    );
    await client.query(
      `INSERT INTO service_accounts(code,subscriber_id,plan_id,plan_version,installation_address,activation_date,billing_start_date,billing_day,due_day,current_rate_centavos,status,area_id,collector_id,notes)
       SELECT 'SVC-'||lpad(n::text,6,'0'),s.id,p.id,1,'Synthetic Street '||n||', Barangay '||(((n-1)%20)+1)||', Volume City',
         current_date-400,current_date-400,s.billing_day,s.due_day,p.price_centavos,'ACTIVE',s.area_id,s.collector_id,''
       FROM generate_series(1,$1) n
       JOIN subscribers s ON s.code='SUB-'||lpad(n::text,6,'0')
       JOIN service_plans p ON p.code='PERF999'`,
      [VOLUME],
    );
    await client.query(
      `INSERT INTO billing_cycles(code,period_start,period_end)
       SELECT to_char(d,'YYYY-MM'),d::date,(d+interval '1 month - 1 day')::date
       FROM generate_series(date_trunc('month',current_date)-(($1::int||' months')::interval),date_trunc('month',current_date),interval '1 month') d`,
      [MONTHS],
    );
    // One invoice per account per cycle. A fifth of them are settled, and a share of those
    // partly, so the receivable is a spread of ages rather than one bucket.
    await client.query(
      `WITH months AS (
         SELECT c.id,c.period_start,c.period_end,row_number() OVER (ORDER BY c.period_start DESC) AS age
         FROM billing_cycles c
       ), made AS (
         SELECT sa.id AS service_id,s.id AS subscriber_id,m.age,m.period_start,m.period_end,(period_end+5) AS due_date,(sa.code::text||'-'||m.age) AS key,
           sa.current_rate_centavos AS total,
           ((('x'||substr(md5(sa.code||m.age),1,8))::bit(32)::int) % 5) AS fate
         FROM generate_series(1,$1) n
         JOIN subscribers s ON s.code='SUB-'||lpad(n::text,6,'0')
         JOIN service_accounts sa ON sa.subscriber_id=s.id
         CROSS JOIN months m
       ), rows AS (
         SELECT row_number() OVER (ORDER BY key) AS seq, made.*
         FROM made
       )
       INSERT INTO invoices(invoice_number,cycle_id,subscriber_id,service_account_id,status,source,period_label,issue_date,due_date,
         subtotal_centavos,adjustment_centavos,total_centavos,paid_centavos,balance_centavos,notes,created_by,finalized_at)
       SELECT 'INV-'||to_char(period_start,'YYYY')||'-'||lpad(seq::text,7,'0'),
         (SELECT id FROM billing_cycles WHERE period_start=rows.period_start),
         subscriber_id,service_id,
         CASE WHEN fate=0 THEN 'PAID' WHEN fate=1 THEN 'PARTIALLY_PAID' WHEN rows.due_date<current_date THEN 'OVERDUE' ELSE 'UNPAID' END,
         'CYCLE',to_char(period_start,'YYYY-MM'),period_start,due_date,
         total,0,total,
         CASE WHEN fate=0 THEN total WHEN fate=1 THEN total/2 ELSE 0 END,
         CASE WHEN fate=0 THEN 0 WHEN fate=1 THEN total-total/2 ELSE total END,
          '',$2::uuid,now()
       FROM rows`,
      [VOLUME, ownerId],
    );
    await client.query(
      `INSERT INTO invoice_items(invoice_id,line_no,item_type,description,service_account_id,plan_id,plan_version,plan_code,plan_name,quantity,unit_price_centavos,amount_centavos)
       SELECT i.id,1,'SUBSCRIPTION','Volume Internet 999',i.service_account_id,p.id,1,p.code,p.name,1,i.total_centavos,i.total_centavos
       FROM invoices i JOIN service_plans p ON p.code='PERF999'`,
    );
    // A cash receipt for every settled invoice, allocated to it. These are the money figures
    // the collection and revenue reports sum, so the reports are measured over real data.
    await client.query(
      `WITH settled AS (
         SELECT i.id,i.subscriber_id,i.total_centavos,i.paid_centavos,i.issue_date,
           row_number() OVER (ORDER BY i.invoice_number) AS seq
         FROM invoices i WHERE i.paid_centavos>0
       )
       INSERT INTO payments(receipt_number,subscriber_id,method,direction,status,amount_centavos,received_on,notes,reason,recorded_by,created_at)
       SELECT 'RCP-'||to_char(issue_date,'YYYY')||'-'||lpad(seq::text,7,'0'),subscriber_id,'CASH','PAYMENT','POSTED',paid_centavos,issue_date+2,'','',$1,now()
       FROM settled`,
      [ownerId],
    );
    await client.query(
      `WITH settled AS (
         SELECT i.id,i.issue_date,row_number() OVER (ORDER BY i.invoice_number) AS seq
         FROM invoices i WHERE i.paid_centavos>0
       )
       INSERT INTO payment_allocations(payment_id,invoice_id,source,amount_centavos,actor_id)
       SELECT p.id,s.id,'PAYMENT',p.amount_centavos,$1
       FROM settled s
       JOIN payments p ON p.receipt_number='RCP-'||to_char(s.issue_date,'YYYY')||'-'||lpad(s.seq::text,7,'0')
       WHERE p.method='CASH' AND p.status='POSTED'`,
      [ownerId],
    );
    // The subscriber ledger: a charge line per invoice and a credit line per receipt, with the
    // running balance the statement report reproduces from the entries themselves.
    await client.query(
      `WITH entries AS (
         SELECT i.subscriber_id,i.id AS reference_id,i.invoice_number AS reference_number,i.due_date AS entry_date,
           'Invoice '||i.invoice_number AS description,i.total_centavos AS debit,0 AS credit,'INVOICE' AS kind,i.id AS invoice_id
         FROM invoices i
         UNION ALL
         SELECT p.subscriber_id,p.id,p.receipt_number,p.received_on,'Payment '||p.receipt_number,0,p.amount_centavos,'PAYMENT',NULL
         FROM payments p WHERE p.status='POSTED' AND p.direction='PAYMENT'
       ), numbered AS (
         SELECT subscriber_id,entry_date,reference_id,reference_number,description,debit,credit,kind,invoice_id,
           row_number() OVER (PARTITION BY subscriber_id ORDER BY entry_date,kind,reference_id) AS entry_no,
           sum(debit-credit) OVER (PARTITION BY subscriber_id ORDER BY entry_date,kind,reference_id) AS balance
         FROM entries
       )
       INSERT INTO ledger_entries(entry_no,subscriber_id,service_account_id,invoice_id,entry_date,reference_type,reference_id,reference_number,description,debit_centavos,credit_centavos,balance_centavos,actor_id)
       SELECT entry_no,subscriber_id,NULL,invoice_id,entry_date,kind,reference_id,reference_number,description,debit,credit,balance,$1
       FROM numbered`,
      [ownerId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  // Vacuum, not just ANALYZE, and the difference matters for the plans below. A bulk insert
  // leaves every heap page unvisited and every trigram index holding an unread pending list, and
  // PostgreSQL charges for both: it costs a GIN search far above what it costs once the pages are
  // in order. Autovacuum does this within minutes of any ordinary run, so a measurement taken
  // straight after seeding would report a plan the office never sees.
  await pool.query(`VACUUM (ANALYZE) ${['subscribers', 'collection_areas', 'collectors', 'service_accounts', 'invoices', 'invoice_items', 'payments', 'payment_allocations', 'ledger_entries'].join(',')}`);
}

/**
 * Times one screen through the API and records the median against its budget.
 *
 * A read is repeated and the median is kept, because one sample can be a cold cache or a
 * background checkpoint. A write is measured once and says so, because repeating it would change
 * the data rather than the measurement.
 */
async function time(name: string, budget: number, runs: number, run: () => Promise<number | string>) {
  const samples: number[] = [];
  let rows: number | string = '';
  for (let attempt = 0; attempt < runs; attempt++) {
    const start = performance.now();
    const detail = await run();
    samples.push(performance.now() - start);
    if (detail !== undefined) rows = detail;
  }
  const medianMs = median(samples);
  results.push({ name, median: medianMs, budget, rows, samples: runs === 1 ? 'once' : runs });
  if (medianMs > budget) failures.push(`${name} took ${Math.round(medianMs)} ms against a ${budget} ms budget.`);
}

const count = (value: unknown) => (Array.isArray((value as { items?: unknown[] }).items) ? (value as { items: unknown[] }).items.length : (value as { total?: number }).total ?? '');

async function measureApi(app: ReturnType<typeof buildApp>, token: string, database: Awaited<ReturnType<typeof createTestDatabase>>) {
  const headers = { authorization: `Bearer ${token}` };
  const get = async (url: string) => {
    const response = await app.inject({ url: `/api/v1${url}`, headers });
    if (response.statusCode >= 400) throw new Error(`${url} returned ${response.statusCode}: ${response.body.slice(0, 400)}`);
    return response.json() as Record<string, unknown>;
  };
  const subscriberId = first((await database.pool.query<{ id: string }>("SELECT id FROM subscribers WHERE code='SUB-000007'")).rows).id;
  const area = await database.pool.query<{ id: string }>("SELECT id FROM collection_areas WHERE code='AREA001'");
  const collector = await database.pool.query<{ id: string }>("SELECT id FROM collectors WHERE code='COLL001'");

  await time('subscriber list', budget('subscriber list'), RUNS, async () => count(await get('/subscribers?page=1&perPage=20')));
  // A term in the middle of a name, which is the case no b-tree index can serve.
  await time('subscriber search', budget('subscriber search'), RUNS, async () => count(await get('/subscribers?q=me%20Subscriber%20000123&page=1&perPage=20')));
  await time('service list', budget('service list'), RUNS, async () => count(await get('/services?page=1&perPage=20')));
  await time('payments list', budget('payments list'), RUNS, async () => count(await get('/payments?page=1&perPage=20')));
  await time('payment account panel', budget('payment account panel'), RUNS, async () => count(await get(`/payments/account?subscriberId=${subscriberId}`)));
  await time('subscriber statement', budget('subscriber statement'), RUNS, async () => count(await get(`/reports/SUBSCRIBER_LEDGER?subscriberId=${subscriberId}&from=2020-01-01&to=2099-12-31&granularity=MONTH`)));
  await time('receivables summary', budget('receivables summary'), RUNS, async () => {
    const summary = await get('/receivables/summary') as { aging: unknown[] };
    return summary.aging.length;
  });
  await time('overdue worklist', budget('overdue worklist'), RUNS, async () => count(await get('/receivables/overdue?page=1&perPage=50')));
  await time('aging report', budget('aging report'), RUNS, async () => count(await get('/reports/AR_AGING')));
  await time('billing versus collection', budget('billing versus collection'), RUNS, async () => count(await get('/reports/BILLING_VS_COLLECTION?from=2020-01-01&to=2099-12-31&granularity=MONTH')));
  await time('revenue report', budget('revenue report'), RUNS, async () => count(await get('/reports/REVENUE?from=2020-01-01&to=2099-12-31&granularity=MONTH&dimension=AREA')));
  await time('subscriber master report', budget('subscriber master report'), RUNS, async () => count(await get('/reports/SUBSCRIBER_MASTER')));
  await time('collector performance', budget('collector performance'), RUNS, async () => count(await get('/reports/COLLECTOR_PERFORMANCE?from=2020-01-01&to=2099-12-31&granularity=MONTH')));
  await time('payment exceptions', budget('payment exceptions'), RUNS, async () => count(await get('/reports/PAYMENT_EXCEPTIONS')));
  await time('audit trail report', budget('audit trail report'), RUNS, async () => count(await get('/reports/AUDIT_TRAIL?from=2020-01-01&to=2099-12-31')));
  await time('collections summary', budget('collections summary'), RUNS, async () => count(await get('/reports/COLLECTIONS?from=2020-01-01&to=2099-12-31&granularity=MONTH')));
  await time('dashboard', budget('dashboard'), RUNS, async () => count(await get('/dashboard')));

  // A write can only be measured once: a second receipt on the same day is a different
  // transaction, and a second route on the same date is rejected outright.
  const today = new Date().toISOString().slice(0, 10);
  await time('record payment', budget('record payment'), 1, async () => {
    // The write path at volume: allocation, receipt numbering, ledger and invoice updates in
    // one transaction, against an account that is behind on several months.
    const response = await app.inject({
      method: 'POST', url: '/api/v1/payments', headers,
      payload: { subscriberId, method: 'CASH', amountCentavos: 50000, receivedOn: today, notes: 'Volume check payment' },
    });
    if (response.statusCode >= 400) throw new Error(`payment returned ${response.statusCode}: ${response.body.slice(0, 400)}`);
    return count(response.json());
  });

  // An area holds a thousand accounts, so the route is opened for a bounded subset: the screen
  // it measures is the one a collector actually walks, not the whole area in one sheet.
  const routeSubscribers = await database.pool.query<{ id: string }>(
    `SELECT s.id FROM subscribers s
     JOIN service_accounts sa ON sa.subscriber_id=s.id AND sa.status='ACTIVE'
     WHERE s.area_id=$1 AND s.collector_id=$2 ORDER BY s.code LIMIT 50`,
    [first(area.rows).id, first(collector.rows).id],
  );
  await time('open collection route', budget('open collection route'), 1, async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/collections/batches', headers,
      payload: {
        collectorId: first(collector.rows).id, areaId: first(area.rows).id, collectionDate: today,
        subscriberIds: routeSubscribers.rows.map((row) => row.id), notes: 'Volume check route',
      },
    });
    if (response.statusCode >= 400) throw new Error(`route returned ${response.statusCode}: ${response.body.slice(0, 400)}`);
    return count(response.json());
  });
}

/**
 * The plans behind the timings.
 *
 * A budget alone proves nothing: a slow query can still be inside it on a small machine, and a
 * fast one can be fast because the data was cached. So each of the three queries the review
 * changed is run with EXPLAIN ANALYZE and the plan is required to name the index, and to not
 * fall back to a sequential scan of the table in question.
 */
async function measurePlans(database: Awaited<ReturnType<typeof createTestDatabase>>) {
  console.log('');
  console.log('Query plans');
  // The first search predicate is the one the subscriber list actually sends: one ILIKE per
  // searched column, combined with OR, exactly as master-data/service.ts builds it.
  const search = ['code', 'name', 'contact', 'email', 'addresses']
    .map((column) => `${column}::text ILIKE $1`)
    .join(' OR ');
  const checks: { label: string; sql: string; values: unknown[]; index: string; table: string }[] = [
    {
      label: 'subscriber search (term in the middle of a name)',
      sql: `EXPLAIN (ANALYZE, TIMING OFF, COSTS OFF) SELECT id FROM subscribers WHERE ${search} LIMIT 20`,
      values: ['%me Subscriber 000123%'], index: 'subscribers_name_trgm_idx', table: 'Seq Scan on subscribers',
    },
    {
      label: 'open invoices for one service account',
      sql: `EXPLAIN (ANALYZE, TIMING OFF, COSTS OFF) SELECT id FROM invoices WHERE service_account_id=$1 AND status IN ('UNPAID','PARTIALLY_PAID','OVERDUE') AND balance_centavos>0`,
      values: [null], index: 'invoices_open_service_idx', table: 'Seq Scan on invoices',
    },
    {
      label: 'last posted payment for one subscriber',
      sql: `EXPLAIN (ANALYZE, TIMING OFF, COSTS OFF) SELECT amount_centavos FROM payments WHERE subscriber_id=$1 AND status='POSTED' AND direction='PAYMENT' ORDER BY received_on DESC,created_at DESC LIMIT 1`,
      values: [null], index: 'payments_posted_subscriber_idx', table: 'Seq Scan on payments',
    },
  ];
  const serviceAccount = await database.pool.query<{ id: string }>("SELECT id FROM service_accounts ORDER BY code LIMIT 1");
  const subscriber = await database.pool.query<{ id: string }>("SELECT id FROM subscribers ORDER BY code LIMIT 1");
  // A trigram index on a few thousand rows is not the cheapest plan and PostgreSQL knows it: the
  // scan of a small table is faster than the bitmap lookups. Below the review volume the index is
  // therefore checked for availability, with the choice taken out of the planner's hands, rather
  // than reported as a failure it would be right to ignore.
  const forced = VOLUME < REVIEW_VOLUME;
  if (forced) console.log(`  ${VOLUME.toLocaleString('en-PH')} subscribers is below the ${REVIEW_VOLUME.toLocaleString('en-PH')} reviewed, so the index is checked for availability rather than for cost.`);
  const client = await database.pool.connect();
  try {
    if (forced) await client.query('SET enable_seqscan = off');
    for (const check of checks) {
      const values = check.values.map((value) => value ?? (check.index.startsWith('invoices') ? first(serviceAccount.rows).id : first(subscriber.rows).id));
      const plan = (await client.query<{ 'QUERY PLAN': string }>(check.sql, values)).rows.map((row) => row['QUERY PLAN']).join('\n');
      const usesIndex = plan.includes(check.index);
      const scansTable = !forced && plan.includes(check.table);
      console.log(`  ${usesIndex && !scansTable ? 'PASS' : 'FAIL'}  ${check.label}`);
      if (!usesIndex || scansTable) console.log(plan.split('\n').map((line) => `          ${line}`).join('\n'));
      if (!usesIndex) failures.push(`The plan for "${check.label}" does not use ${check.index}.`);
      if (scansTable) failures.push(`The plan for "${check.label}" falls back to ${check.table}.`);
    }
  } finally {
    if (forced) await client.query('RESET enable_seqscan');
    client.release();
  }
}

/**
 * Correctness at volume.
 *
 * A fast wrong answer is worse than a slow right one, so the figures the review timed are
 * checked against the stored rows they summarise. If an optimisation ever pushed a filter into
 * the wrong place, this is where it would show.
 */
async function measureCorrectness(app: ReturnType<typeof buildApp>, token: string, database: Awaited<ReturnType<typeof createTestDatabase>>) {
  const asOf = new Date().toISOString().slice(0, 10);
  const summary = (await app.inject({ url: `/api/v1/receivables/summary?asOf=${asOf}`, headers: { authorization: `Bearer ${token}` } })).json() as {
    totalReceivableCentavos: number; aging: { totalCentavos: number }[];
  };
  const stored = await database.pool.query<{ total: string }>(
    `SELECT coalesce(sum(balance_centavos),0) AS total FROM invoices WHERE status IN ('UNPAID','PARTIALLY_PAID','OVERDUE') AND balance_centavos>0`,
  );
  const buckets = summary.aging.reduce((sum, bucket) => sum + bucket.totalCentavos, 0);
  const total = Number(first(stored.rows).total);
  const checks: [string, boolean, string][] = [
    ['the receivable total equals the stored open balances', summary.totalReceivableCentavos === total, `${summary.totalReceivableCentavos} against ${total}`],
    ['the aging buckets add back to the receivable total', buckets === summary.totalReceivableCentavos, `${buckets} against ${summary.totalReceivableCentavos}`],
  ];
  console.log('');
  console.log('Correctness at volume');
  for (const [label, passed, detail] of checks) {
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label} (${detail})`);
    if (!passed) failures.push(`${label}: ${detail}`);
  }
}

await main();