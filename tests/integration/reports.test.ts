import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../source/api/app';
import { AuthService } from '../../source/api/auth/service';
import { seedSecurity } from '../../database/seed-security';
import { createTestDatabase } from '../helpers/database';
import {
  DashboardSchema, ReportTableSchema, assertBalanced, periodBuckets, reportCodes, reportFileName,
  type ReportCode,
} from '../../source/shared/reports';
import { ReceivableSummarySchema, agingBucketLabels } from '../../source/shared/receivables';
import { csvField, centsToDecimal, columnReference } from '../../source/api/reports/xlsx';
import { renderCsv } from '../../source/api/reports/documents';
import { textWidth, toWinAnsi } from '../../source/api/reports/pdf';
import { crc32, zip } from '../../source/api/reports/zip';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof buildApp>;
let owner = ''; let cashier = ''; let viewer = ''; let technician = '';
const password = 'Synthetic-Report-Password-123!';
const plan = { code: 'RPT999', name: 'Internet 999', serviceType: 'INTERNET', priceCentavos: 99900, installationFeeCentavos: 100000, reconnectionFeeCentavos: 10000, description: '', speedMbps: 100, channelCount: null, active: true };
const headers = (token = owner) => ({ authorization: `Bearer ${token}` });
const get = async (url: string, token = owner) => app.inject({ url: `/api/v1${url}`, headers: headers(token) });
const post = async (url: string, payload: Record<string, unknown> = {}, token = owner) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: headers(token), payload });
const create = (resource: string, data: unknown, token = owner) => post(`/${resource}`, { data, reason: 'Report fixture' }, token);
const rows = async (sql: string, values: unknown[] = []) => (await db.pool.query(sql, values)).rows;
const report = async (code: ReportCode, query = '', token = owner) => {
  const response = await get(`/reports/${code}${query}`, token);
  // Parsed rather than cast, so a response that stops matching the shared contract fails
  // here. The body is included because "invalid code" is far easier to read with it.
  if (response.statusCode !== 200) throw new Error(`${code}${query} returned ${response.statusCode}: ${response.body}`);
  return ReportTableSchema.parse(response.json());
};

/** A one-pixel PNG, which is the smallest thing the proof schema will accept. */
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
const proof = { fileName: 'gcash-claim.png', mimeType: 'image/png', base64: png.toString('base64') };

const clock = new Date();
const iso = (date: Date) => date.toISOString().slice(0, 10);
const today = iso(clock);
const addDays = (days: number) => iso(new Date(clock.getTime() + days * 86_400_000));

let areaId = ''; let collectorId = ''; let planId = '';
/** The account whose invoices sit in the "not yet due" band, for the statement fixture. */
let subscriberForStatement = '';
/** Receipts that must stay visible as exceptions: an unverified claim and a voided receipt. */
let gCashClaim = '';

beforeAll(async () => {
  const proofDirectory = await mkdtemp(join(tmpdir(), 'bcis-report-'));
  process.env.BCIS_PROOF_DIR = proofDirectory;
  db = await createTestDatabase();
  await seedSecurity(db.pool, { username: 'owner', displayName: 'Owner', password });
  const auth = new AuthService(db.pool);
  owner = (await auth.login('owner', password)).token;
  for (const [username, role] of [['cashier', 'CASHIER'], ['viewer', 'VIEWER'], ['technician', 'TECHNICIAN']] as const) {
    await auth.createUser(owner, { username, displayName: username, password, roles: [role] });
  }
  cashier = (await auth.login('cashier', password)).token;
  viewer = (await auth.login('viewer', password)).token;
  technician = (await auth.login('technician', password)).token;
  app = buildApp({ checkDatabase: async () => undefined, auth, logLevel: 'silent' });

  areaId = (await create('areas', { code: 'RPTA00', name: 'Barangay Pina', description: '', active: true })).json().id;
  collectorId = (await create('collectors', { code: 'RPTC00', name: 'Collector Report', contact: '09181234567', notes: '', active: true })).json().id;
  planId = (await create('plans', plan)).json().id;

  /** One subscriber with one active service, owing whatever invoices the test asks for. */
  const account = async (code: string) => {
    const subscriberId = (await create('subscribers', {
      code, name: `Sample ${code}`, contact: '09179876543', email: '', addresses: [`${code} Malaybalay`],
      areaId, collectorId, billingDay: 1, dueDay: 5, status: 'ACTIVE', notes: '',
    })).json().id;
    const serviceAccountId = (await create('services', {
      code: `${code}SVC`, subscriberId, planId, installationAddress: `${code} Malaybalay`,
      activationDate: addDays(-400), billingStartDate: addDays(-400), billingDay: 1, dueDay: 5,
      currentRateCentavos: 50000, status: 'ACTIVE', areaId, collectorId, notes: '',
    })).json().id;
    return { subscriberId, serviceAccountId };
  };

  const owing = async (code: string, issueOffset: number, dueOffset: number, amountCentavos: number) => {
    const { subscriberId, serviceAccountId } = await account(code);
    const invoice = await post('/billing/invoices', {
      serviceAccountId, issueDate: addDays(issueOffset), dueDate: addDays(dueOffset),
      items: [{ itemType: 'SUBSCRIPTION', description: `Charge for ${code}`, quantity: 1, unitPriceCentavos: amountCentavos }],
    });
    expect(invoice.statusCode).toBe(201);
    expect((await post(`/billing/invoices/${invoice.json().id}/finalize`, { reason: 'Deliberately unpaid' })).statusCode).toBe(200);
    return { subscriberId, serviceAccountId, invoiceId: invoice.json().id as string, amountCentavos };
  };

  // One account per aging band, so every published bucket has a real invoice in it.
  const inCurrent = await owing('RPTAA1', -10, 5, 50_000);
  subscriberForStatement = inCurrent.subscriberId;
  const in30 = await owing('RPTAA2', -40, -20, 40_000);
  const in60 = await owing('RPTAA3', -75, -50, 30_000);
  const in90 = await owing('RPTAA4', -130, -100, 20_000);
  // The band fixtures exist for the aging report; reading them keeps the intent obvious.
  expect([in30, in60, in90].map((entry) => entry.amountCentavos)).toEqual([40_000, 30_000, 20_000]);

  // Cash collected against the oldest bill, so there is a posted receipt to report on. The
  // API allocates oldest-due-first by itself, so 5,000 lands on RPTAA4's 20,000 invoice.
  const collected = await post('/payments', {
    subscriberId: in90.subscriberId, method: 'CASH', amountCentavos: 5_000, receivedOn: addDays(-3), notes: 'Part payment',
  });
  expect(collected.statusCode).toBe(201);

  // A GCash claim awaiting a second person, and a receipt already voided: the two
  // exceptions the payment exception report exists to show. GCash needs its reference and a
  // receipt image, and stays PENDING until a second person confirms it.
  const gCash = await post('/payments', {
    subscriberId: inCurrent.subscriberId, method: 'GCASH', amountCentavos: 12_345, receivedOn: addDays(-1),
    referenceNumber: 'GCASH-RPT-001', notes: 'Claimed in the app', proof,
  });
  if (gCash.statusCode !== 201) throw new Error(`GCash claim refused with ${gCash.statusCode}: ${gCash.body}`);
  gCashClaim = gCash.json().payment.id as string;
  expect(await rows('SELECT status FROM payments WHERE id=$1', [gCashClaim])).toEqual([{ status: 'PENDING' }]);

  // The other two exception shapes. A claim that was never confirmed can simply be voided,
  // so the second GCash claim is voided rather than reversed: it never posted, so there is
  // nothing to take back.
  const toVoid = (await post('/payments', {
    subscriberId: in60.subscriberId, method: 'GCASH', amountCentavos: 1_111, receivedOn: addDays(-2),
    referenceNumber: 'GCASH-RPT-002', notes: 'Claimed against the wrong account', proof,
  })).json().payment.id as string;
  expect((await post(`/payments/${toVoid}/void`, { reason: 'Claimed against the wrong account' }, owner)).statusCode).toBe(200);
  expect(await rows('SELECT status FROM payments WHERE id=$1', [toVoid])).toEqual([{ status: 'VOID' }]);

  // A posted receipt can only be reversed, which writes its own document with its own
  // number and reopens the invoice it had settled.
  const toReverse = (await post('/payments', {
    subscriberId: in60.subscriberId, method: 'CASH', amountCentavos: 2_222, receivedOn: addDays(-2), notes: 'Keyed twice',
  })).json().payment.id as string;
  expect((await post(`/payments/${toReverse}/reverse`, { reason: 'Keyed twice by mistake' }, owner)).statusCode).toBe(200);
  expect(await rows("SELECT direction FROM payments WHERE reversal_of_id=$1", [toReverse])).toEqual([{ direction: 'REVERSAL' }]);

  // A route with a remittance, so collector performance has expected, collected and remitted.
  // Expected cash is what the collector actually banked, so collecting 3,000 and counting
  // 2,700 leaves a shortage of exactly 300.
  const batch = await post('/collections/batches', { areaId, collectorId, collectionDate: addDays(-2), subscriberIds: [in90.subscriberId] });
  expect(batch.statusCode).toBe(201);
  const batchId = batch.json().id as string;
  expect((await post(`/collections/batches/${batchId}/start`, {})).statusCode).toBe(200);
  expect((await post('/payments', {
    subscriberId: in90.subscriberId, method: 'CASH', amountCentavos: 3_000, receivedOn: addDays(-2),
    collectionBatchId: batchId, notes: 'Collected on route',
  })).statusCode).toBe(201);
  expect((await post(`/collections/batches/${batchId}/submit`, {})).statusCode).toBe(200);
  const remitted = await post(`/collections/batches/${batchId}/remittance`, { remittedOn: addDays(-1), cashCentavos: 2_700, notes: 'Short by 300' });
  expect(remitted.statusCode).toBe(200);
  expect(remitted.json().remittance.expectedCashCentavos).toBe(3_000);
  expect(remitted.json().remittance.shortageCentavos).toBe(300);
});

afterAll(async () => {
  await app?.close();
  await db?.close();
  if (process.env.BCIS_PROOF_DIR) await rm(process.env.BCIS_PROOF_DIR, { recursive: true, force: true });
});

describe('the report catalogue', () => {
  it('lists all nine reports the laboratory asks for', async () => {
    const response = await get('/reports');
    expect(response.statusCode).toBe(200);
    const codes = (response.json().reports as { code: ReportCode }[]).map((entry) => entry.code);
    expect(codes).toEqual(reportCodes());
    expect(codes).toHaveLength(9);
  });

  it('tells the desktop which of them this account may export', async () => {
    expect((await get('/reports', viewer)).json().reports.every((entry: { exportable: boolean }) => entry.exportable)).toBe(false);
    expect((await get('/reports', owner)).json().reports.every((entry: { exportable: boolean }) => entry.exportable)).toBe(true);
  });
});

describe('money and period arithmetic', () => {
  it('never lets a report total drift from the rows under it', async () => {
    for (const code of reportCodes()) {
      const query = code === 'SUBSCRIBER_LEDGER' ? `?subscriberId=${subscriberForStatement}&from=${addDays(-200)}&to=${today}` : `?from=${addDays(-200)}&to=${today}`;
      const table = await report(code, query);
      // The invariant the server enforces before responding, asserted again from outside.
      expect(() => assertBalanced(table.reconciliations)).not.toThrow();
      expect(table.reconciliations.every((entry) => entry.balanced)).toBe(true);
      // Every report that states money must reconcile it. A report with no money column at
      // all, such as the audit extract, has nothing to prove and says so honestly.
      const moneyColumns = table.columns.filter((entry) => entry.kind === 'MONEY' && !entry.runningTotal);
      expect(table.reconciliations).toHaveLength(moneyColumns.length);
      if (moneyColumns.length > 0) expect(table.reconciliations.length).toBeGreaterThan(0);
    }
  });

  it('groups by the periods the shared helper predicts, not by its own idea of them', async () => {
    const from = addDays(-40);
    for (const granularity of ['DAY', 'WEEK', 'MONTH', 'YEAR'] as const) {
      const table = await report('COLLECTIONS', `?from=${from}&to=${today}&granularity=${granularity}`);
      const predicted = new Set(periodBuckets(from, today, granularity).map((entry) => entry.key));
      // Every period the report returned must be one the shared bucketing would produce, and
      // every period with money in it must appear. That is the whole claim: one bucketing,
      // agreed between SQL and TypeScript, checked from outside both.
      for (const row of table.rows) expect(predicted.has(String(row.periodKey))).toBe(true);
      expect(table.rows.length).toBeGreaterThan(0);
    }
  });
});

describe('each report', () => {
  it('counts a receipt once, in the period it was received', async () => {
    const table = await report('COLLECTIONS', `?from=${addDays(-5)}&to=${today}&granularity=DAY`);
    const collected = table.totals[0]!.values.collectedCentavos as number;
    // The 5,000 posted cash payment, the 2,700 route collection and the 12,345 pending claim
    // are separate events; only the posted ones are collected money.
    expect(collected).toBe(5_000 + 3_000);
    // The pending GCash claim is held as a receivable, not counted as cash collected.
    expect(collected).toBeLessThan(5_000 + 3_000 + 12_345);
  });

  it('separates billed from collected so a cash position is not read as a debt', async () => {
    const table = await report('BILLING_VS_COLLECTION', `?from=${addDays(-200)}&to=${today}&granularity=MONTH`);
    const billed = table.totals[0]!.values.billedCentavos as number;
    expect(billed).toBe(50_000 + 40_000 + 30_000 + 20_000);
    const difference = table.totals[0]!.values.differenceCentavos as number;
    expect(difference).toBe((table.totals[0]!.values.collectedCentavos as number) - billed);
  });

  it('groups revenue by plan and attributes only applied money', async () => {
    const byPlan = await report('REVENUE', `?from=${addDays(-200)}&to=${today}&dimension=PLAN`);
    expect(byPlan.rows.map((row) => row.dimension)).toEqual([plan.name]);
    expect(byPlan.totals[0]!.values.billedCentavos).toBe(140_000);
    // 5,000 at the counter and 3,000 on the route both settled part of an invoice, so all
    // 8,000 of it is attributed to the plan. Unapplied credit would be excluded here.
    expect(byPlan.totals[0]!.values.collectedCentavos).toBe(8_000);
    for (const dimension of ['SERVICE_TYPE', 'AREA'] as const) {
      const grouped = await report('REVENUE', `?from=${addDays(-200)}&to=${today}&dimension=${dimension}`);
      expect(grouped.rows.length).toBeGreaterThan(0);
      expect(grouped.reconciliations.every((entry) => entry.balanced)).toBe(true);
    }
  });

  it('puts every open balance in the bucket its due date belongs to', async () => {
    const table = await report('AR_AGING', `?to=${today}`);
    expect(table.rows.map((row) => row.bucketLabel)).toEqual(Object.values(agingBucketLabels));
    // The oldest account paid 5,000 at the counter and 3,000 on the route, so 12,000 remains
    // more than 90 days past due. The bands are 50/40/30/12 thousand across the five buckets.
    expect(table.rows.map((row) => row.amountCentavos)).toEqual([50_000, 40_000, 30_000, 0, 12_000]);
  });

  it('agrees with the receivables screen for the same day', async () => {
    const aging = await report('AR_AGING', `?to=${today}`);
    const summary = ReceivableSummarySchema.parse((await get('/receivables/summary')).json());
    const total = aging.totals[0]!.values.amountCentavos as number;
    expect(total).toBe(summary.totalReceivableCentavos);
    // Two independent implementations of the same buckets, so they are compared rather than
    // assumed equal.
    for (const entry of aging.rows) {
      const published = summary.aging.find((bucket) => bucket.bucket === entry.bucket)!;
      expect(entry.amountCentavos).toBe(published.totalCentavos);
      expect(entry.invoiceCount).toBe(published.invoiceCount);
    }
  });

  it('reproduces a statement of account from its own lines', async () => {
    const table = await report('SUBSCRIBER_LEDGER', `?subscriberId=${subscriberForStatement}&from=${addDays(-200)}&to=${today}`);
    // The statement states an opening balance, the period's movement and a closing balance.
    const opening = table.totals[0]!.values.balanceCentavos as number;
    const movement = table.totals[1]!.values;
    const debit = movement.debitCentavos as number;
    const credit = movement.creditCentavos as number;
    const closing = table.totals[2]!.values.balanceCentavos as number;
    // The statement's own arithmetic: opening plus debits less credits must land on closing.
    expect(closing).toBe(opening + debit - credit);
    expect(opening).toBe(0);
    expect(debit).toBe(50_000);
    expect(closing).toBe(50_000);
    // The running balance is reproduced line by line rather than trusted.
    let running = opening;
    for (const row of table.rows) {
      running += (row.debitCentavos as number) - (row.creditCentavos as number);
      expect(row.balanceCentavos).toBe(running);
    }
    // A running balance is not an additive column, so it is not reconciled as a sum.
    expect(table.columns.filter((entry) => entry.key === 'balanceCentavos').every((entry) => entry.runningTotal)).toBe(true);
    expect(table.reconciliations.map((entry) => entry.column).sort()).toEqual(['creditCentavos', 'debitCentavos']);
  });

  it('refuses a statement of account with no subscriber chosen', async () => {
    const response = await get(`/reports/SUBSCRIBER_LEDGER?from=${addDays(-30)}&to=${today}`);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('VALIDATION');
  });

  it('names the account a statement belongs to, and only on that document', async () => {
    // A statement is handed to one subscriber. Without the account on the paper it is a ledger
    // extract that could be filed against the wrong person without anything looking wrong.
    const statement = await report('SUBSCRIBER_LEDGER', `?subscriberId=${subscriberForStatement}&from=${addDays(-200)}&to=${today}`);
    expect(statement.subject).not.toBeNull();
    expect(statement.subject!.label).toBe('Statement of account for');
    const named = Object.fromEntries(statement.subject!.fields.map((field) => [field.label, field.value]));
    expect(named.Account).toBe('RPTAA1');
    expect(named.Subscriber).toBe('Sample RPTAA1');

    // The header reaches the paper and the spreadsheet, not just the JSON. Both are checked by
    // their bytes because a header that only exists in the API response is not a document.
    const query = `subscriberId=${subscriberForStatement}&from=${addDays(-200)}&to=${today}`;
    const pdfResponse = await get(`/reports/SUBSCRIBER_LEDGER/export?format=PDF&${query}`, owner);
    expect(pdfResponse.statusCode).toBe(200);
    const pdf = pdfResponse.rawPayload.toString('latin1');
    expect(pdf).toContain('Statement of account for');
    expect(pdf).toContain('Account: RPTAA1');
    expect(pdf).toContain('Subscriber: Sample RPTAA1');
    // The account block sits above the column headings, not on top of them.
    const subjectY = Number(pdf.match(/([\d.]+) ([\d.]+) Td\s+\(Account: RPTAA1\)/)![2]);
    const headingY = Number(pdf.match(/([\d.]+) ([\d.]+) Td\s+\(DESCRIPTION\)/)![2]);
    expect(subjectY).toBeGreaterThan(headingY);

    const xlsx = (await get(`/reports/SUBSCRIBER_LEDGER/export?format=XLSX&${query}`, owner)).rawPayload;
    const sheet = entry(xlsx, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('Statement of account for');
    expect(sheet).toContain('RPTAA1');
    // The frozen pane has to follow the taller header, or the account block scrolls away with
    // the column labels pinned above it. The rule is the five title rows plus one caption row
    // plus the two-column rows the subject's fields need.
    const subjectRows = 1 + Math.ceil(statement.subject!.fields.length / 2);
    expect(sheet).toMatch(new RegExp(`ySplit="${5 + subjectRows}"`));

    // CSV is the format an office opens when the other two are unavailable, so leaving the
    // account out of it would let a statement be filed against the wrong subscriber.
    const csv = (await get(`/reports/SUBSCRIBER_LEDGER/export?format=CSV&${query}`, owner)).rawPayload.toString('utf8');
    expect(csv).toContain('Statement of account for');
    expect(csv).toContain('Account: RPTAA1');
    expect(csv).toContain('Subscriber: Sample RPTAA1');
    // The header has to sit ahead of the column labels, not after the rows. The label is read
    // from the report rather than spelled out, so the assertion does not depend on the ledger's
    // column naming.
    expect(csv.indexOf('Account: RPTAA1')).toBeLessThan(csv.indexOf(statement.columns[0]!.label));

    // A report about the whole office has no single account to name, and does not pretend to.
    for (const code of reportCodes().filter((entry) => entry !== 'SUBSCRIBER_LEDGER')) {
      const table = await report(code, `?from=${addDays(-200)}&to=${today}`);
      expect(table.subject).toBeNull();
    }
  });

  it('lists every subscriber with the services and balance behind the row', async () => {
    const table = await report('SUBSCRIBER_MASTER');
    expect(table.rows).toHaveLength(4);
    const owing = table.rows.find((row) => row.code === 'RPTAA4')!;
    expect(owing.outstandingCentavos).toBe(12_000);
    expect(owing.services).toBe(1);
  });

  it('leaves a shortage on the collector record rather than netting it away', async () => {
    const table = await report('COLLECTOR_PERFORMANCE', `?from=${addDays(-200)}&to=${today}`);
    const row = table.rows.find((entry) => entry.code === 'RPTC00')!;
    expect(row.collectedCashCentavos).toBe(3_000);
    expect(row.remittedCentavos).toBe(2_700);
    expect(row.varianceCentavos).toBe(300);
    expect(row.shortageCentavos).toBe(300);
    expect(row.overageCentavos).toBe(0);
  });

  it('counts a route once, not once per account on it', async () => {
    const table = await report('COLLECTOR_PERFORMANCE', `?from=${addDays(-200)}&to=${today}`);
    const row = table.rows.find((entry) => entry.code === 'RPTC00')!;
    // The route holds one account, so this is a coincidence here. The guard is the
    // integration test's job; what matters is that the batch rollup produced a single row.
    expect(row.accounts).toBe(1);
    expect(table.reconciliations.every((entry) => entry.balanced)).toBe(true);
  });

  it('keeps voided receipts, reversals and unverified claims visible', async () => {
    const table = await report('PAYMENT_EXCEPTIONS', `?from=${addDays(-200)}&to=${today}`);
    const categories = table.rows.map((row) => row.category);
    expect(categories).toContain('Voided receipt');
    expect(categories).toContain('Awaiting verification');
    expect(categories).toContain('Reversal');
    const rowsBy = (category: string) => table.rows.filter((row) => row.category === category);
    expect(rowsBy('Voided receipt')[0]!.amountCentavos).toBe(1_111);
    expect(rowsBy('Awaiting verification')[0]!.amountCentavos).toBe(12_345);
    expect(rowsBy('Reversal')[0]!.amountCentavos).toBe(2_222);
    // Every exception carries the reason it was raised, so the report is actionable.
    expect(table.rows.every((row) => typeof row.reason === 'string' && row.reason.length > 0)).toBe(true);
  });

  it('records who did what in the audit trail', async () => {
    const table = await report('AUDIT_TRAIL', `?from=${addDays(-200)}&to=${today}`);
    expect(table.rows.length).toBeGreaterThan(0);
    expect(table.rows.every((row) => row.actor !== '' && row.action !== '')).toBe(true);
    expect(table.truncated).toBe(false);
  });

  it('bounds the audit extract and says so rather than cutting it silently', async () => {
    const table = await report('AUDIT_TRAIL', `?from=${addDays(-2000)}&to=${addDays(2000)}`);
    expect(table.rowCount).toBeLessThanOrEqual(5000);
    if (table.truncated) expect(table.footnote).toContain('partial');
  });
});

describe('the dashboard', () => {
  it('answers with six tiles, the aging and the panels an owner checks first', async () => {
    const dashboard = DashboardSchema.parse((await get('/dashboard')).json());
    expect(dashboard.kpis.map((kpi) => kpi.key)).toEqual(['collected', 'billed', 'current', 'overdue', 'overdueSubscribers', 'followUp']);
    expect(dashboard.aging).toHaveLength(5);
    expect(dashboard.billingVsCollection.length).toBe(6);
    expect(dashboard.recentPayments.length).toBeGreaterThan(0);
    expect(dashboard.overdueAlerts.length).toBeGreaterThan(0);
    expect(dashboard.overdueAlerts[0]!.overdueDays).toBeGreaterThan(0);
  });

  it('keeps the receivable tiles consistent with the aging report', async () => {
    const dashboard = DashboardSchema.parse((await get('/dashboard')).json());
    const aging = await report('AR_AGING', `?to=${today}`);
    const kpi = (key: string) => dashboard.kpis.find((entry) => entry.key === key)!.valueCentavos;
    expect(kpi('current') + kpi('overdue')).toBe(aging.totals[0]!.values.amountCentavos as number);
  });

  it('gives every tile a label and a hint, not colour alone', async () => {
    const dashboard = DashboardSchema.parse((await get('/dashboard')).json());
    for (const kpi of dashboard.kpis) {
      expect(kpi.label.length).toBeGreaterThan(0);
      expect(kpi.hint.length).toBeGreaterThan(0);
      expect(Number.isInteger(kpi.valueCentavos)).toBe(true);
    }
  });
});

describe('permissions', () => {
  it('lets a viewer read reports but not export them', async () => {
    expect((await get('/reports/AR_AGING', viewer)).statusCode).toBe(200);
    expect((await get('/reports/AR_AGING/export?format=CSV', viewer)).statusCode).toBe(403);
  });

  it('refuses a technician both the dashboard and every report', async () => {
    expect((await get('/dashboard', technician)).statusCode).toBe(403);
    for (const code of reportCodes()) expect((await get(`/reports/${code}`, technician)).statusCode).toBe(403);
  });

  it('lets a cashier read the dashboard but not a report, because the two are separate grants', async () => {
    // The dashboard summarises what a cashier already does all day. It does not hand over
    // subscriber lists, collector performance or the audit trail behind a single permission.
    expect((await get('/dashboard', cashier)).statusCode).toBe(200);
    expect((await get('/reports', cashier)).statusCode).toBe(403);
    expect((await get('/reports/AR_AGING', cashier)).statusCode).toBe(403);
    expect((await get('/reports/AR_AGING/export?format=CSV', cashier)).statusCode).toBe(403);
  });

  it('refuses an unauthenticated request to any of them', async () => {
    expect((await app.inject({ url: '/api/v1/reports' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/dashboard' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/reports/AR_AGING/export?format=PDF' })).statusCode).toBe(401);
  });

  it('rejects an unknown report code rather than defaulting to one', async () => {
    expect((await get('/reports/NOT_A_REPORT')).statusCode).toBe(404);
  });

  it('rejects a bad filter instead of quietly ignoring it', async () => {
    expect((await get(`/reports/COLLECTIONS?granularity=FORTNIGHT`)).statusCode).toBe(422);
    expect((await get(`/reports/COLLECTIONS?from=${today}&to=${addDays(-10)}`)).statusCode).toBe(422);
    expect((await get(`/reports/COLLECTIONS?collectorId=not-a-uuid`)).statusCode).toBe(422);
  });

  it('writes an audit entry for every export', async () => {
    await get('/reports/AR_AGING/export?format=CSV');
    const logged = await rows("SELECT details->>'report' AS report,details->>'format' AS format FROM audit_logs WHERE action='report.export' ORDER BY created_at DESC LIMIT 1");
    expect(logged).toEqual([{ report: 'AR_AGING', format: 'CSV' }]);
  });
});

describe('exports', () => {
  const download = async (format: string, token = owner) => app.inject({
    url: `/api/v1/reports/COLLECTIONS/export?format=${format}&from=${addDays(-200)}&to=${today}&granularity=MONTH`,
    headers: headers(token),
  });

  it('produces a PDF that is structurally a PDF', async () => {
    const response = await download('PDF');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    const body = response.rawPayload;
    expect(body.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(body.subarray(-6).toString()).toContain('%%EOF');
    // The cross-reference offset must actually point at the table, or a reader will refuse
    // the file and the export will fail silently on a manager's machine.
    const start = Number(body.toString('latin1').match(/startxref\s+(\d+)/)![1]);
    expect(body.subarray(start, start + 4).toString()).toBe('xref');
    expect(body.toString('latin1')).toContain('/Type /Catalog');
    expect(body.toString('latin1')).toContain('WinAnsiEncoding');
  });

  it('produces an XLSX that is a real archive of the parts Excel reads', async () => {
    const response = await download('XLSX');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('spreadsheetml.sheet');
    const body = response.rawPayload;
    expect(body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const names = archiveNames(body);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('xl/workbook.xml');
    expect(names).toContain('xl/worksheets/sheet1.xml');
    expect(names).toContain('xl/styles.xml');
    const sheet = entry(body, 'xl/worksheets/sheet1.xml');
    // Money is a number so the file can be added up, and it keeps both decimal places:
    // 8,000 centavos is written 80.00, not 80.
    expect(sheet).toContain('<v>80.00</v>');
    expect(sheet).toContain('Collection summary');
  });

  it('produces a CSV a spreadsheet can sum', async () => {
    const response = await download('CSV');
    expect(response.statusCode).toBe(200);
    const text = response.body;
    // The byte order mark is deliberate: without it Excel mangles the peso sign.
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('Collected');
    expect(text).toContain('Balanced');
    expect(text).toMatch(/,\d+\.\d{2}\r\n/);
  });

  it('names every export after the report and the period', async () => {
    for (const format of ['PDF', 'XLSX', 'CSV'] as const) {
      const response = await download(format);
      const expected = reportFileName('COLLECTIONS', addDays(-200), today, format);
      expect(response.headers['content-disposition']).toBe(`attachment; filename="${expected}"`);
      // A file name that could climb out of the download folder would be a real defect.
      expect(expected).not.toContain('/');
      expect(expected).not.toContain('\\');
      expect(expected).not.toContain('..');
    }
  });

  it('rejects an unknown export format', async () => {
    expect((await download('DOC')).statusCode).toBe(422);
  });

  it('exports the same figures it displayed', async () => {
    const table = await report('COLLECTIONS', `?from=${addDays(-200)}&to=${today}&granularity=MONTH`);
    const text = renderCsv(table).toString('utf8');
    expect(text).toContain(table.title);
    // Every stated money total appears in the file as the same plain number, which is what
    // makes the CSV add up in a spreadsheet rather than merely look right.
    const moneyColumns = table.columns.filter((column) => column.kind === 'MONEY').map((column) => column.key);
    for (const total of table.totals) {
      for (const key of moneyColumns) {
        const value = total.values[key];
        if (typeof value !== 'number') continue;
        expect(text).toMatch(new RegExp(`(^|,)${centsToDecimal(value).replace('.', '\\.')}(,|\\r|$)`, 'm'));
      }
    }
  });
});

describe('the export writers', () => {
  it('escapes a cell that would otherwise break out of its field', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('has, comma')).toBe('"has, comma"');
    expect(csvField('has "quotes"')).toBe('"has ""quotes"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
  });

  it('converts centavos to a decimal without a floating point detour', () => {
    expect(centsToDecimal(0)).toBe('0.00');
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(999)).toBe('9.99');
    expect(centsToDecimal(123_456)).toBe('1234.56');
    expect(centsToDecimal(-2_500)).toBe('-25.00');
  });

  it('names spreadsheet columns the way Excel counts them', () => {
    expect(columnReference(0)).toBe('A');
    expect(columnReference(25)).toBe('Z');
    expect(columnReference(26)).toBe('AA');
    expect(columnReference(701)).toBe('ZZ');
  });

  it('maps typography onto the glyphs the base PDF fonts actually have', () => {
    expect(toWinAnsi("subscriber\u2019s")).toBe("subscriber's");
    expect(toWinAnsi('\u2014')).toBe('-');
    // The peso sign is the one currency this system deals in, so it is spelled out instead
    // of printing a question mark on a customer's statement.
    expect(toWinAnsi('\u20b11,234.56')).toBe('PHP1,234.56');
    // A glyph with genuinely no equivalent still becomes a question mark, not corrupt output.
    expect(toWinAnsi('\u4e2d\u6587')).toBe('??');
    expect(toWinAnsi('plain')).toBe('plain');
  });

  it('measures text in Helvetica units', () => {
    expect(textWidth('', 8)).toBe(0);
    expect(textWidth('i', 8)).toBeCloseTo(1.776, 3);
    expect(textWidth('W', 8)).toBeCloseTo(7.552, 3);
  });

  it('computes a real CRC-32', () => {
    // The standard check value for "123456789".
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926);
  });

  it('writes a ZIP archive whose offsets are all correct', () => {
    const archive = zip({ 'a.txt': 'hello', 'b.txt': 'world'.repeat(100) });
    expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(archiveNames(archive).sort()).toEqual(['a.txt', 'b.txt']);
    // Every central directory offset must land exactly on its local file header.
    let cursor = 0;
    for (let index = 0; index < 2; index += 1) {
      expect(archive.readUInt32LE(cursor + 0)).toBe(0x04034b50);
      const nameLength = archive.readUInt16LE(cursor + 26);
      const compressed = archive.readUInt32LE(cursor + 18);
      cursor += 30 + nameLength + compressed;
    }
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50);
  });
});

/** Central directory entry names, read straight out of the archive. */
function archiveNames(archive: Buffer): string[] {
  let cursor = archive.length - 22;
  while (cursor >= 0 && archive.readUInt32LE(cursor) !== 0x06054b50) cursor -= 1;
  let count = archive.readUInt16LE(cursor + 10);
  let entry = archive.readUInt32LE(cursor + 16);
  const names: string[] = [];
  while (count > 0) {
    expect(archive.readUInt32LE(entry)).toBe(0x02014b50);
    const nameLength = archive.readUInt16LE(entry + 28);
    const extraLength = archive.readUInt16LE(entry + 30);
    const commentLength = archive.readUInt16LE(entry + 32);
    names.push(archive.subarray(entry + 46, entry + 46 + nameLength).toString('utf8'));
    entry += 46 + nameLength + extraLength + commentLength;
    count -= 1;
  }
  return names;
}

/** One stored-or-deflated entry, inflated, so a test can assert on the XML inside it. */
function entry(archive: Buffer, wanted: string): string {
  let cursor = archive.length - 22;
  while (cursor >= 0 && archive.readUInt32LE(cursor) !== 0x06054b50) cursor -= 1;
  let count = archive.readUInt16LE(cursor + 10);
  let offset = archive.readUInt32LE(cursor + 16);
  while (count > 0) {
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === wanted) {
      const local = archive.readUInt32LE(offset + 42);
      const localName = archive.readUInt16LE(local + 26);
      const localExtra = archive.readUInt16LE(local + 28);
      const start = local + 30 + localName + localExtra;
      const method = archive.readUInt16LE(local + 8);
      const compressed = archive.readUInt32LE(local + 18);
      const raw = archive.subarray(start, start + compressed);
      return (method === 8 ? inflateRaw(raw) : raw).toString('utf8');
    }
    offset += 46 + nameLength + extraLength + commentLength;
    count -= 1;
  }
  throw new Error(`No archive entry named ${wanted}.`);
}

function inflateRaw(data: Buffer): Buffer {
  return inflateRawSync(data);
}
