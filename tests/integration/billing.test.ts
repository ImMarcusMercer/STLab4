import { beforeAll, afterAll, it, expect } from 'vitest';
import { buildApp } from '../../source/api/app';
import { AuthService } from '../../source/api/auth/service';
import { seedSecurity } from '../../database/seed-security';
import { createTestDatabase } from '../helpers/database';
import { BillingCycleSchema, InvoiceSchema, LedgerSchema, decimalMoney } from '../../source/shared/billing';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof buildApp>;
let owner: string; let cashier: string; let supervisor: string; let technician: string;
const password = 'Synthetic-Billing-Password-123!';
const plan = { code: 'BILL999', name: 'Internet 999', serviceType: 'INTERNET', priceCentavos: 99900, installationFeeCentavos: 100000, reconnectionFeeCentavos: 10000, description: '', speedMbps: 100, channelCount: null, active: true };
const subscriber = { code: 'BSUB001', name: 'Billing Sample', contact: '09171234567', email: 'sample@example.test', addresses: ['Malaybalay billing address'], areaId: null, collectorId: null, billingDay: 1, dueDay: 15, status: 'ACTIVE', notes: '' };
const headers = (token = owner) => ({ authorization: `Bearer ${token}` });
const get = async (url: string, token = owner) => app.inject({ url: `/api/v1${url}`, headers: headers(token) });
const post = async (url: string, payload: Record<string, unknown> = {}, token = owner) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: headers(token), payload });
const put = async (url: string, payload: Record<string, unknown>, token = owner) => app.inject({ method: 'PUT', url: `/api/v1${url}`, headers: headers(token), payload });
const create = (resource: string, data: unknown, token = owner) => post(`/${resource}`, { data, reason: 'Billing fixture' }, token);
const service = (code: string, extra: Record<string, unknown> = {}) => ({
  code, subscriberId: '', planId: '', installationAddress: `${code} installation address`, activationDate: '2026-06-01', billingStartDate: '2026-06-01',
  billingDay: 1, dueDay: 15, currentRateCentavos: 99900, status: 'ACTIVE', areaId: null, collectorId: null, notes: '', ...extra,
});
const invoiceByCode = async (code: string) => (await get('/billing/invoices?perPage=100')).json().items.find((row: { serviceCode: string }) => row.serviceCode === code);
const invoicesFor = async (code: string) => (await get(`/billing/invoices?perPage=100&q=${code}`)).json().items.filter((row: { serviceCode: string }) => row.serviceCode === code);
const invoiceById = async (id: string) => (await get(`/billing/invoices/${id}`)).json();
const ledgerOf = async (subscriberId: string) => (await get(`/billing/ledger?subscriberId=${subscriberId}&perPage=200`)).json();
// The master-data contract is strict, so a saved record is trimmed back to its input
// fields before it is sent as an update.
const inputOf = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !['id', 'version', 'createdAt', 'planVersion'].includes(key)));
const attemptDb = async (statement: string, values: unknown[] = []) => db.pool.query(statement, values).then(() => 'allowed', (error: { code: string }) => error.code);

let subscriberId = ''; let firstServiceId = ''; let cycleInvoiceId = ''; let manualInvoiceId = ''; let manualInvoiceNumber = ''; let ownerId = '';

beforeAll(async () => {
  db = await createTestDatabase();
  await seedSecurity(db.pool, { username: 'owner', displayName: 'Owner', password });
  const auth = new AuthService(db.pool);
  owner = (await auth.login('owner', password)).token;
  ownerId = (await db.pool.query('SELECT id FROM users WHERE username=$1', ['owner'])).rows[0].id as string;
  for (const [username, role] of [['cashier', 'CASHIER'], ['supervisor', 'SUPERVISOR'], ['technician', 'TECHNICIAN']] as const) await auth.createUser(owner, { username, displayName: username, password, roles: [role] });
  cashier = (await auth.login('cashier', password)).token;
  supervisor = (await auth.login('supervisor', password)).token;
  technician = (await auth.login('technician', password)).token;
  // The suite deliberately provokes refused requests and one detected inconsistency, so
  // the application log is silenced and the assertions carry the evidence.
  app = buildApp({ checkDatabase: async () => undefined, auth, logLevel: 'silent' });

  const planId = (await create('plans', plan)).json().id;
  subscriberId = (await create('subscribers', subscriber)).json().id;
  firstServiceId = (await create('services', service('BSVC001', { subscriberId, planId }))).json().id;
  await create('services', service('BSVC002', { subscriberId, planId, currentRateCentavos: 35000, billingDay: 25, dueDay: 5 }));
  // A service that is not yet active is not billable.
  await create('services', service('BSVC003', { subscriberId, planId, status: 'PENDING', activationDate: null }));
});

afterAll(async () => { await app?.close(); await db?.close(); });

it('rejects anonymous, read-only and unauthorized billing requests', async () => {
  expect((await app.inject('/api/v1/billing/invoices')).statusCode).toBe(401);
  expect((await get('/billing/invoices', technician)).statusCode).toBe(403);
  // A supervisor may not open a subscriber statement, but a cashier may.
  expect((await get('/billing/invoices', supervisor)).statusCode).toBe(403);
  expect((await get('/billing/invoices', cashier)).statusCode).toBe(200);
  expect((await get(`/billing/ledger?subscriberId=${subscriberId}`, technician)).statusCode).toBe(403);
  // Cashier and supervisor can read billing but never generate or correct it.
  for (const body of [{ period: '2026-09' }, {}]) {
    expect((await post('/billing/runs', body, cashier)).statusCode).toBe(403);
    expect((await post('/billing/runs', body, supervisor)).statusCode).toBe(403);
  }
  expect((await post('/billing/invoices', { serviceAccountId: firstServiceId, issueDate: '2026-09-05', dueDate: '2026-09-20', items: [{ itemType: 'SUBSCRIPTION', description: 'Charge', quantity: 1, unitPriceCentavos: 100 }] }, cashier)).statusCode).toBe(403);
  expect((await post(`/billing/invoices/${firstServiceId}/void`, { reason: 'Not allowed' }, supervisor)).statusCode).toBe(403);
  // A posted financial row is never reachable through a destructive route.
  expect((await app.inject({ method: 'DELETE', url: `/api/v1/billing/invoices/${firstServiceId}`, headers: headers() })).statusCode).toBe(404);
  expect((await app.inject({ method: 'PATCH', url: `/api/v1/billing/invoices/${firstServiceId}`, headers: headers(), payload: { status: 'PAID' } })).statusCode).toBe(404);
});

it('generates one invoice per eligible service with an immutable rate snapshot', async () => {
  const run = await post('/billing/runs', { period: '2026-09', asOf: '2026-09-10' });
  expect(run.statusCode).toBe(200);
  expect(run.json()).toMatchObject({ cycleCode: '2026-09', periodLabel: 'September 2026', asOf: '2026-09-10', invoiceCount: 2, skippedCount: 0, totalCentavos: 134900, idempotent: false });
  expect(run.json().invoiceNumber).toBeUndefined();

  const list = await get('/billing/invoices?cycleCode=2026-09');
  expect(list.statusCode).toBe(200);
  expect(list.json().total).toBe(2);
  const first = list.json().items.find((row: { serviceCode: string }) => row.serviceCode === 'BSVC001');
  cycleInvoiceId = first.id;
  expect(InvoiceSchema.safeParse(first)).toMatchObject({ success: true });
  expect(first).toMatchObject({ invoiceNumber: 'INV-2026-1001', status: 'UNPAID', source: 'CYCLE', totalCentavos: 99900, subtotalCentavos: 99900, adjustmentCentavos: 0, balanceCentavos: 99900, paidCentavos: 0, issueDate: '2026-09-01', dueDate: '2026-09-15', periodLabel: 'September 2026', subscriberCode: 'BSUB001' });
  expect(first.items).toHaveLength(1);
  expect(first.items[0]).toMatchObject({ lineNo: 1, itemType: 'SUBSCRIPTION', quantity: 1, unitPriceCentavos: 99900, amountCentavos: 99900, planCode: 'BILL999', planName: 'Internet 999', planVersion: 1 });
  // A due day before the billing day falls into the following month.
  expect(await invoiceByCode('BSVC002')).toMatchObject({ invoiceNumber: 'INV-2026-1002', totalCentavos: 35000, issueDate: '2026-09-25', dueDate: '2026-10-05' });
  // The pending service is not billable and never receives a document.
  expect(JSON.stringify(list.json())).not.toContain('BSVC003');
  expect(BillingCycleSchema.safeParse((await get('/billing/cycles')).json().items[0]).success).toBe(true);
});

it('prevents duplicate billing for the same service account and period (AT-11)', async () => {
  const before = (await get('/billing/invoices?cycleCode=2026-09')).json().total;
  const runId = (await get('/billing/runs')).json().items[0].id;
  for (const attempt of [1, 2]) {
    const repeat = await post('/billing/runs', { period: '2026-09' });
    expect(repeat.statusCode, `attempt ${attempt}`).toBe(200);
    expect(repeat.json()).toMatchObject({ cycleCode: '2026-09', invoiceCount: 2, skippedCount: 2, idempotent: true });
    expect(repeat.json().id).toBe(runId);
  }
  expect((await get('/billing/invoices?cycleCode=2026-09')).json().total).toBe(before);
  // Concurrent generation of the same period still produces one invoice per service.
  const concurrent = await Promise.all([post('/billing/runs', { period: '2026-09' }), post('/billing/runs', { period: '2026-09' })]);
  expect(concurrent.map((response) => response.statusCode)).toEqual([200, 200]);
  expect((await get('/billing/invoices?cycleCode=2026-09')).json().total).toBe(before);
  expect((await get('/billing/runs')).json().items.length).toBe(1);
  // Each service account still holds exactly one finalised invoice for the period.
  for (const code of ['BSVC001', 'BSVC002']) {
    const rows = (await get(`/billing/invoices?cycleCode=2026-09&q=${code}`)).json().items.filter((row: { status: string }) => row.status !== 'VOID');
    expect(rows.length).toBe(1);
  }
});

it('reproduces the subscriber ledger balance from the posted entries alone', async () => {
  const response = await get(`/billing/ledger?subscriberId=${subscriberId}`);
  expect(response.statusCode).toBe(200);
  expect(LedgerSchema.safeParse(response.json())).toMatchObject({ success: true });
  const body = response.json();
  expect(body.verified).toBe(true);
  expect(body.openingBalanceCentavos).toBe(0);
  // The statement is ordered by entry date, so the 1st-of-month charge is line 1.
  expect(body.items.map((row: { referenceNumber: string }) => row.referenceNumber)).toEqual(['INV-2026-1001', 'INV-2026-1002']);
  expect(body.items.map((row: { entryNo: number }) => row.entryNo)).toEqual([1, 2]);
  expect(body.items.map((row: { debitCentavos: number }) => row.debitCentavos)).toEqual([99900, 35000]);
  expect(body.items.map((row: { balanceCentavos: number }) => row.balanceCentavos)).toEqual([99900, 134900]);
  expect(body.totalDebitCentavos).toBe(134900);
  expect(body.totalCreditCentavos).toBe(0);
  expect(body.closingBalanceCentavos).toBe(134900);
  // The stored running balance is exactly the sum of the append-only entries.
  const stored = await db.pool.query('SELECT entry_no AS "entryNo",entry_date AS "entryDate",debit_centavos AS "debitCentavos",credit_centavos AS "creditCentavos",balance_centavos AS "balanceCentavos" FROM ledger_entries WHERE subscriber_id=$1 ORDER BY entry_date,entry_no', [subscriberId]);
  let running = 0;
  for (const row of stored.rows) { running += row.debitCentavos - row.creditCentavos; expect(row.balanceCentavos).toBe(running); }
  // Paging the statement reproduces the running balance of the page while the account
  // balance at the end of the range stays the same.
  const paged = (await get(`/billing/ledger?subscriberId=${subscriberId}&perPage=1&page=2`)).json();
  expect(paged.items).toHaveLength(1);
  expect(paged.openingBalanceCentavos).toBe(99900);
  expect(paged.closingBalanceCentavos).toBe(134900);
  expect(paged.total).toBe(2);
  // A date range opens with the balance brought forward by the entries before it and
  // closes at the balance reached at the end of the range.
  const september = (await get(`/billing/ledger?subscriberId=${subscriberId}&from=2026-09-25`)).json();
  expect(september.items.map((row: { invoiceNumber: string }) => row.invoiceNumber)).toEqual(['INV-2026-1002']);
  expect(september).toMatchObject({ verified: true, openingBalanceCentavos: 99900, closingBalanceCentavos: 134900, totalDebitCentavos: 35000, totalCreditCentavos: 0, total: 1 });
  const closed = (await get(`/billing/ledger?subscriberId=${subscriberId}&from=2026-09-01&to=2026-09-01`)).json();
  expect(closed).toMatchObject({ openingBalanceCentavos: 0, closingBalanceCentavos: 99900, total: 1 });
  // An empty range is not an error, it is an empty statement.
  const empty = (await get(`/billing/ledger?subscriberId=${subscriberId}&from=2020-01-01&to=2020-12-31`)).json();
  expect(empty).toMatchObject({ verified: true, items: [], total: 0, openingBalanceCentavos: 0, closingBalanceCentavos: 0 });
});

it('keeps a posted invoice unchanged when the plan price and service rate change', async () => {
  const before = await invoiceByCode('BSVC001');
  const plans = (await get('/plans?q=BILL999')).json().items[0];
  const changed = await put(`/plans/${plans.id}`, { data: { ...plan, priceCentavos: 109900 }, version: plans.version, reason: 'Seasonal price increase' });
  expect(changed.statusCode).toBe(200);
  const accounts = (await get('/services?q=BSVC002')).json().items[0];
  const rerated = await put(`/services/${accounts.id}`, { data: { ...inputOf(accounts), currentRateCentavos: 45000 }, version: accounts.version, reason: 'Agreed new rate' });
  expect(rerated.statusCode).toBe(200);
  expect(rerated.json().currentRateCentavos).toBe(45000);
  // The September documents keep the rate that was contracted for that period.
  expect(await invoiceByCode('BSVC001')).toEqual(before);
  expect((await invoiceByCode('BSVC002')).items[0].amountCentavos).toBe(35000);
  expect((await invoiceByCode('BSVC001')).totalCentavos).toBe(99900);
  await put(`/plans/${plans.id}`, { data: plan, version: changed.json().version, reason: 'Restore the fixture price' });
});

it('creates, re-issues, numbers and finalises a manual draft invoice', async () => {
  const draft = await post('/billing/invoices', { serviceAccountId: firstServiceId, issueDate: '2026-09-05', dueDate: '2026-09-20', notes: 'Installation and discount', items: [
    { itemType: 'INSTALLATION', description: 'Installation fee', quantity: 1, unitPriceCentavos: 100000 },
    { itemType: 'SUBSCRIPTION', description: 'September subscription', quantity: 1, unitPriceCentavos: 99900 },
    { itemType: 'DISCOUNT', description: 'Promo discount', quantity: 1, unitPriceCentavos: 50000 },
  ] });
  expect(draft.statusCode).toBe(201);
  manualInvoiceId = draft.json().id;
  expect(InvoiceSchema.safeParse(draft.json())).toMatchObject({ success: true });
  expect(draft.json()).toMatchObject({ status: 'DRAFT', source: 'MANUAL', invoiceNumber: null, cycleCode: null, subtotalCentavos: 199900, adjustmentCentavos: -50000, totalCentavos: 149900, balanceCentavos: 149900 });
  expect(draft.json().items.map((row: { lineNo: number }) => row.lineNo)).toEqual([1, 2, 3]);
  // A draft carries no number and no statement line, and a correction to it is a re-issue
  // rather than an adjustment, because nothing has been posted yet.
  expect(draft.json().adjustments).toEqual([]);
  expect((await ledgerOf(subscriberId)).items.filter((row: { invoiceId: string | null }) => row.invoiceId === manualInvoiceId)).toHaveLength(0);
  expect((await post(`/billing/invoices/${manualInvoiceId}/adjustments`, { adjustmentType: 'DEBIT', amountCentavos: 500, reason: 'Adjust a draft' })).statusCode).toBe(409);
  // A discarded draft is voided rather than deleted, so the record of the attempt remains.
  const discarded = await post('/billing/invoices', { serviceAccountId: firstServiceId, issueDate: '2026-09-05', dueDate: '2026-09-20', items: [{ itemType: 'SUBSCRIPTION', description: 'Raised by mistake', quantity: 1, unitPriceCentavos: 99900 }] });
  const voided = await post(`/billing/invoices/${discarded.json().id}/void`, { reason: 'Raised by mistake' });
  expect(voided.statusCode).toBe(200);
  expect(voided.json()).toMatchObject({ status: 'VOID', invoiceNumber: null, balanceCentavos: 0, voidReason: 'Raised by mistake' });
  expect((await ledgerOf(subscriberId)).items.filter((row: { invoiceId: string | null }) => row.invoiceId === discarded.json().id)).toHaveLength(0);
  // A draft may still be re-issued, and the replacement lines replace the whole set.
  const revised = await put(`/billing/invoices/${manualInvoiceId}/items`, { items: [{ itemType: 'INSTALLATION', description: 'Installation fee only', quantity: 1, unitPriceCentavos: 100000 }], reason: 'Only the installation fee applies' });
  expect(revised.statusCode).toBe(200);
  expect(revised.json()).toMatchObject({ totalCentavos: 100000, adjustmentCentavos: 0, status: 'DRAFT', invoiceNumber: null });
  expect(revised.json().items).toHaveLength(1);
  const finalised = await post(`/billing/invoices/${manualInvoiceId}/finalize`, { reason: 'Issue to the subscriber', asOf: '2026-09-06' });
  expect(finalised.statusCode).toBe(200);
  manualInvoiceNumber = finalised.json().invoiceNumber;
  expect(finalised.json()).toMatchObject({ status: 'UNPAID', invoiceNumber: expect.stringMatching(/^INV-2026-\d{4,}$/), subtotalCentavos: 100000, adjustmentCentavos: 0, totalCentavos: 100000, finalizedAt: expect.any(String) });
  // Finalised documents are frozen: re-issuing, adjusting totals or deleting are refused.
  expect((await put(`/billing/invoices/${manualInvoiceId}/items`, { items: [{ itemType: 'INSTALLATION', description: 'Changed', quantity: 1, unitPriceCentavos: 1 }], reason: 'Attempt to change a posted invoice' })).statusCode).toBe(409);
  expect((await post(`/billing/invoices/${manualInvoiceId}/finalize`, { reason: 'Attempt to issue twice' })).statusCode).toBe(409);
  // The ledger received the posted debit exactly once.
  const ledger = await ledgerOf(subscriberId);
  expect(ledger.items.filter((row: { invoiceId: string | null }) => row.invoiceId === manualInvoiceId)).toHaveLength(1);
});

it('records debit and credit adjustments without editing any posted line', async () => {
  const invoice = await invoiceById(cycleInvoiceId);
  const originalLine = invoice.items[0];
  const debit = await post(`/billing/invoices/${cycleInvoiceId}/adjustments`, { adjustmentType: 'DEBIT', amountCentavos: 20000, reason: 'Late reconnection fee' });
  expect(debit.statusCode).toBe(200);
  expect(debit.json()).toMatchObject({ subtotalCentavos: 99900, adjustmentCentavos: 20000, totalCentavos: 119900, balanceCentavos: 119900, status: 'UNPAID' });
  const credit = await post(`/billing/invoices/${cycleInvoiceId}/adjustments`, { adjustmentType: 'CREDIT', amountCentavos: 30000, reason: 'Goodwill discount' });
  expect(credit.statusCode).toBe(200);
  expect(credit.json()).toMatchObject({ subtotalCentavos: 99900, adjustmentCentavos: -10000, totalCentavos: 89900, balanceCentavos: 89900 });
  expect(credit.json().items).toHaveLength(3);
  // The original subscription line is untouched and still first in the document.
  expect(credit.json().items[0]).toEqual(originalLine);
  expect(credit.json().items.slice(1).map((row: { itemType: string; amountCentavos: number }) => [row.itemType, row.amountCentavos])).toEqual([['ADJUSTMENT', 20000], ['ADJUSTMENT', -30000]]);
  expect(credit.json().adjustments).toHaveLength(2);
  expect(credit.json().adjustments[1]).toMatchObject({ adjustmentType: 'CREDIT', amountCentavos: 30000, reason: 'Goodwill discount', actorName: 'Owner' });
  // A credit may not exceed or settle the outstanding balance.
  expect((await post(`/billing/invoices/${cycleInvoiceId}/adjustments`, { adjustmentType: 'CREDIT', amountCentavos: 89900, reason: 'Over-credit attempt' })).statusCode).toBe(422);
  expect((await post(`/billing/invoices/${cycleInvoiceId}/adjustments`, { adjustmentType: 'CREDIT', amountCentavos: 100000, reason: 'Over-credit attempt' })).statusCode).toBe(422);
  expect((await post(`/billing/invoices/${cycleInvoiceId}/adjustments`, { adjustmentType: 'DEBIT', amountCentavos: 0, reason: 'Zero adjustment' })).statusCode).toBe(422);
  expect((await post(`/billing/invoices/${cycleInvoiceId}/adjustments`, { adjustmentType: 'DEBIT', amountCentavos: 1.5, reason: 'Fractional adjustment' })).statusCode).toBe(422);
  expect((await post(`/billing/invoices/${cycleInvoiceId}/adjustments`, { adjustmentType: 'DEBIT', amountCentavos: 100, reason: 'x' })).statusCode).toBe(422);
  // Each adjustment posted its own ledger entry and the statement still reproduces.
  const entries = (await ledgerOf(subscriberId)).items.filter((row: { invoiceId: string | null }) => row.invoiceId === cycleInvoiceId);
  expect(entries).toHaveLength(3);
  expect(entries.map((row: { referenceType: string }) => row.referenceType)).toEqual(['INVOICE', 'ADJUSTMENT', 'ADJUSTMENT']);
  expect(entries.map((row: { debitCentavos: number; creditCentavos: number }) => row.debitCentavos - row.creditCentavos).reduce((sum: number, value: number) => sum + value, 0)).toBe(89900);
});

it('rebuilds the running balance when a back-dated period is generated', async () => {
  const earlier = await post('/billing/runs', { period: '2026-06', asOf: '2026-06-25' });
  expect(earlier.statusCode).toBe(200);
  // BSVC002 was re-rated in the previous test, so the back-dated period uses the
  // current rate while the September document keeps the contracted one.
  expect(earlier.json()).toMatchObject({ cycleCode: '2026-06', periodLabel: 'June 2026', invoiceCount: 2, skippedCount: 0, totalCentavos: 144900, idempotent: false });
  const ledger = await ledgerOf(subscriberId);
  // The back-dated documents were posted last, so they hold the highest statement
  // numbers while the date ordering still places them on the first lines.
  expect(ledger.items[0]).toMatchObject({ entryNo: 6, entryDate: '2026-06-01', invoiceNumber: expect.stringMatching(/^INV-2026-/), balanceCentavos: 99900 });
  expect(ledger.items[1]).toMatchObject({ entryNo: 7, entryDate: '2026-06-25' });
  expect(ledger.items.map((row: { entryNo: number }) => row.entryNo).slice(2)).toEqual([1, 3, 2, 4, 5]);
  let running = 0;
  for (const row of ledger.items) { running += row.debitCentavos - row.creditCentavos; expect(row.balanceCentavos).toBe(running); }
  expect(ledger.closingBalanceCentavos).toBe(running);
  // Document numbers are allocated once and never reused, even for a back-dated
  // period, and one number never refers to two documents even when a document
  // carries several statement lines.
  const documents = new Map<string, Set<string>>();
  for (const row of ledger.items as { invoiceNumber: string; invoiceId: string | null }[]) {
    expect(row.invoiceNumber).toMatch(/^INV-2026-\d{4,}$/);
    const ids = documents.get(row.invoiceNumber) ?? new Set<string>();
    ids.add(row.invoiceId ?? '');
    documents.set(row.invoiceNumber, ids);
  }
  for (const ids of documents.values()) expect(ids.size).toBe(1);
  expect(documents.size).toBe(5);
  const june = ledger.items.filter((row: { entryDate: string }) => row.entryDate.startsWith('2026-06'));
  expect(june).toHaveLength(2);
  expect(Math.max(...june.map((row: { balanceCentavos: number }) => row.balanceCentavos))).toBeLessThan(Math.min(...ledger.items.filter((row: { entryDate: string }) => row.entryDate > '2026-06-30').map((row: { balanceCentavos: number }) => row.balanceCentavos)));
});

it('voids an invoice with a reason and a linked reversal that restores the balance', async () => {
  const target = await invoiceByCode('BSVC002');
  const before = await ledgerOf(subscriberId);
  const voided = await post(`/billing/invoices/${target.id}/void`, { reason: 'Service disconnected before the charge' });
  expect(voided.statusCode).toBe(200);
  expect(voided.json()).toMatchObject({ status: 'VOID', invoiceNumber: 'INV-2026-1002', voidReason: 'Service disconnected before the charge', paidCentavos: 35000, balanceCentavos: 0, voidedAt: expect.any(String) });
  // The document and its lines are preserved, never deleted.
  expect(voided.json().items).toHaveLength(1);
  expect((await get(`/billing/invoices/${target.id}`)).json().status).toBe('VOID');
  // A void is final: no second reversal and no correction of a voided document.
  expect((await post(`/billing/invoices/${target.id}/void`, { reason: 'Attempt to void twice' })).statusCode).toBe(409);
  expect((await post(`/billing/invoices/${target.id}/adjustments`, { adjustmentType: 'DEBIT', amountCentavos: 100, reason: 'Adjust a voided invoice' })).statusCode).toBe(409);
  const after = await ledgerOf(subscriberId);
  const reversals = after.items.filter((row: { referenceType: string }) => row.referenceType === 'VOID');
  expect(reversals).toHaveLength(1);
  expect(reversals[0]).toMatchObject({ invoiceNumber: 'INV-2026-1002', debitCentavos: 0, creditCentavos: 35000, reversalOfId: expect.any(String) });
  expect(after.closingBalanceCentavos).toBe(before.closingBalanceCentavos - 35000);
  let running = 0;
  for (const row of after.items) { running += row.debitCentavos - row.creditCentavos; expect(row.balanceCentavos).toBe(running); }
  // The voided period slot is free again, and a re-run issues a replacement with a new
  // number instead of a duplicate (AT-11).
  const rerun = await post('/billing/runs', { period: '2026-09' });
  expect(rerun.statusCode).toBe(200);
  expect(rerun.json()).toMatchObject({ idempotent: true, invoiceCount: 2, skippedCount: 1 });
  const replacement = (await invoicesFor('BSVC002')).find((row: { status: string }) => row.status !== 'VOID');
  expect(replacement).toBeDefined();
  expect(replacement!.invoiceNumber).not.toBe('INV-2026-1002');
  expect(replacement!.totalCentavos).toBe(45000);
  const finalisedForPeriod = (await get('/billing/invoices?cycleCode=2026-09&perPage=100')).json().items.filter((row: { serviceCode: string; status: string }) => row.serviceCode === 'BSVC002' && row.status !== 'VOID');
  expect(finalisedForPeriod).toHaveLength(1);
  expect(finalisedForPeriod[0].id).toBe(replacement!.id);
});

it('marks due invoices overdue and never sweeps a settled or voided document', async () => {
  // The back-dated June documents were already overdue when they were issued, so the
  // sweep is compared against the documents that were unpaid immediately before it.
  const unpaidBefore = (await get('/billing/invoices?status=UNPAID&perPage=100')).json().items.map((row: { id: string }) => row.id);
  const sweep = await post('/billing/overdue-sweep', { asOf: '2026-11-30' });
  expect(sweep.statusCode).toBe(200);
  expect(sweep.json()).toMatchObject({ asOf: '2026-11-30' });
  expect(sweep.json().markedCount).toBe(unpaidBefore.length);
  expect(sweep.json().markedCentavos).toBeGreaterThan(0);
  const overdue = (await get('/billing/invoices?status=OVERDUE&perPage=100')).json();
  expect(unpaidBefore.every((id: string) => overdue.items.some((row: { id: string }) => row.id === id))).toBe(true);
  expect(overdue.total).toBeGreaterThanOrEqual(sweep.json().markedCount);
  for (const row of overdue.items) { expect(row.balanceCentavos).toBeGreaterThan(0); expect(row.dueDate < '2026-11-30').toBe(true); }
  // Nothing else changed state, and a second sweep is a no-op.
  expect((await post('/billing/overdue-sweep', { asOf: '2026-11-30' })).json().markedCount).toBe(0);
  expect((await get('/billing/invoices?status=OVERDUE&q=INV-2026-1002')).json().total).toBe(0);
  expect((await get(`/billing/invoices/${cycleInvoiceId}`)).json().status).toBe('OVERDUE');
});

it('rejects a billing request that does not validate', async () => {
  expect((await get('/billing/invoices?status=UNKNOWN')).statusCode).toBe(422);
  expect((await get('/billing/invoices?sort=evil')).statusCode).toBe(422);
  expect((await get('/billing/invoices/11111111-1111-4111-8111-111111111111')).statusCode).toBe(404);
  expect((await get('/billing/invoices/not-a-uuid')).statusCode).toBe(422);
  expect((await get('/billing/ledger?subscriberId=11111111-1111-4111-8111-111111111111')).statusCode).toBe(404);
  expect((await get('/billing/ledger?from=2026-13-01')).statusCode).toBe(422);
  expect((await get('/billing/ledger')).statusCode).toBe(422);
  expect((await post('/billing/runs', { period: '2026-13' })).statusCode).toBe(422);
  expect((await post('/billing/runs', { period: '2026-09', unexpected: true })).statusCode).toBe(422);
  const line = { itemType: 'SUBSCRIPTION', description: 'Charge', quantity: 1, unitPriceCentavos: 100 };
  expect((await post('/billing/invoices', { serviceAccountId: firstServiceId, issueDate: '2026-09-05', dueDate: '2026-09-01', items: [line] })).statusCode).toBe(422);
  expect((await post('/billing/invoices', { serviceAccountId: '11111111-1111-4111-8111-111111111111', issueDate: '2026-09-05', dueDate: '2026-09-20', items: [line] })).statusCode).toBe(422);
  expect((await post('/billing/invoices', { serviceAccountId: firstServiceId, issueDate: '2026-09-05', dueDate: '2026-09-20', items: [] })).statusCode).toBe(422);
  expect((await post('/billing/invoices', { serviceAccountId: firstServiceId, issueDate: '2026-09-05', dueDate: '2026-09-20', items: [{ ...line, unitPriceCentavos: 1.5 }] })).statusCode).toBe(422);
  expect((await post('/billing/invoices', { serviceAccountId: firstServiceId, issueDate: '2026-09-05', dueDate: '2026-09-20', items: [{ ...line, unitPriceCentavos: 0 }] })).statusCode).toBe(422);
  expect((await post('/billing/invoices', { serviceAccountId: firstServiceId, issueDate: '2026-09-05', dueDate: '2026-09-20', items: [{ ...line, quantity: 0 }] })).statusCode).toBe(422);
  // A discount larger than the charge is refused instead of producing a negative invoice.
  expect((await post('/billing/invoices', { serviceAccountId: firstServiceId, issueDate: '2026-09-05', dueDate: '2026-09-20', items: [line, { itemType: 'DISCOUNT', description: 'Too large', quantity: 1, unitPriceCentavos: 1000 }] })).statusCode).toBe(422);
  expect((await post(`/billing/invoices/11111111-1111-4111-8111-111111111111/void`, { reason: 'Missing invoice' })).statusCode).toBe(404);
  expect((await post('/billing/overdue-sweep', { asOf: '2026-11-31' })).statusCode).toBe(422);
});

it('refuses direct edits and deletes of posted financial rows in the database', async () => {
  const invoice = await invoiceById(cycleInvoiceId);
  const attempt = async (statement: string, values: unknown[] = []) => db.pool.query(statement, values).then(() => 'allowed', (error: { message: string; code: string }) => `${error.code}: ${error.message}`);
  expect(await attempt('UPDATE invoice_items SET amount_centavos=1 WHERE id=$1', [invoice.items[0].id])).toContain('bcis_immutable_row');
  expect(await attempt('DELETE FROM invoice_items WHERE id=$1', [invoice.items[0].id])).toContain('bcis_immutable_row');
  expect(await attempt('UPDATE adjustments SET amount_centavos=1 WHERE invoice_id=$1', [cycleInvoiceId])).toContain('bcis_immutable_row');
  expect(await attempt("UPDATE ledger_entries SET credit_centavos=1 WHERE invoice_id=$1", [cycleInvoiceId])).toContain('bcis_immutable_row');
  expect(await attempt('DELETE FROM ledger_entries WHERE invoice_id=$1', [cycleInvoiceId])).toContain('bcis_immutable_row');
  expect(await attempt("UPDATE invoices SET total_centavos=1,balance_centavos=1 WHERE id=$1", [cycleInvoiceId])).toContain('bcis_immutable_row');
  expect(await attempt("UPDATE invoices SET status='VOID',void_reason='Tampered directly' WHERE id=$1", [cycleInvoiceId])).toContain('bcis_immutable_row');
  expect(await attempt("UPDATE invoices SET invoice_number='INV-2026-0001' WHERE id=$1", [cycleInvoiceId])).toContain('bcis_immutable_row');
  expect(await attempt('DELETE FROM invoices WHERE id=$1', [cycleInvoiceId])).toContain('bcis_immutable_row');
  // A second finalised invoice for the same service and period is refused by the database.
  const duplicate = await db.pool.query(
    `INSERT INTO invoices(invoice_number,cycle_id,subscriber_id,service_account_id,status,source,period_label,issue_date,due_date,subtotal_centavos,adjustment_centavos,total_centavos,paid_centavos,balance_centavos,created_by)
     SELECT 'INV-2026-9999',i.cycle_id,i.subscriber_id,i.service_account_id,'UNPAID','MANUAL',i.period_label,i.issue_date,i.due_date,1,0,1,0,1,i.created_by FROM invoices i WHERE i.id=$1`,
    [cycleInvoiceId],
  ).then(() => 'allowed', (error: { code: string }) => error.code);
  expect(duplicate).toBe('23505');
  // The stored totals still satisfy the invoice invariant after every correction.
  const invalid2 = await db.pool.query(
    `INSERT INTO invoices(invoice_number,subscriber_id,service_account_id,status,source,period_label,issue_date,due_date,subtotal_centavos,adjustment_centavos,total_centavos,paid_centavos,balance_centavos,created_by)
     VALUES('INV-2026-8888',$1,$2,'UNPAID','MANUAL','September 2026','2026-09-01','2026-09-15',100,0,999,0,999,$3)`,
    [subscriberId, firstServiceId, ownerId],
  ).then(() => 'allowed', (error: { code: string }) => error.code);
  expect(invalid2).toBe('23514');
});

it('refuses to present a statement that cannot be reproduced, then rebuilds it on the next posting', async () => {
  // The running balance is the only derived column the posting transaction may rewrite,
  // so a direct write is possible, but the read path refuses to show it as final.
  const first = (await ledgerOf(subscriberId)).items[0];
  expect(await attemptDb('UPDATE ledger_entries SET balance_centavos=balance_centavos+7 WHERE id=$1', [first.id])).toBe('allowed');
  const corrupted = await get(`/billing/ledger?subscriberId=${subscriberId}`);
  expect(corrupted.statusCode).toBe(500);
  expect(corrupted.json().error.code).toBe('LEDGER_INCONSISTENT');
  // The next posting rebuilds every balance of the subscriber from the append-only entries.
  const repair = await post(`/billing/invoices/${manualInvoiceId}/adjustments`, { adjustmentType: 'DEBIT', amountCentavos: 500, reason: 'Late fee that repairs the statement' });
  expect(repair.statusCode).toBe(200);
  const repaired = (await get(`/billing/ledger?subscriberId=${subscriberId}`)).json();
  expect(repaired.verified).toBe(true);
  let running = 0;
  for (const row of repaired.items) { running += row.debitCentavos - row.creditCentavos; expect(row.balanceCentavos).toBe(running); }
  expect(repaired.closingBalanceCentavos).toBe(running);
});

it('keeps every stored amount an exact integer of centavos', async () => {
  const invoice = await invoiceById(cycleInvoiceId);
  expect(invoice.totalCentavos).toBe(89900);
  expect(decimalMoney(invoice.totalCentavos)).toBe('899.00');
  expect(Number.isInteger(invoice.totalCentavos)).toBe(true);
  const stored = await db.pool.query('SELECT subtotal_centavos,adjustment_centavos,total_centavos,paid_centavos,balance_centavos FROM invoices');
  for (const row of stored.rows) for (const value of Object.values(row)) expect(String(value)).toMatch(/^-?\d+$/);
  const amounts = await db.pool.query('SELECT amount_centavos,unit_price_centavos FROM invoice_items');
  // pg returns bigint columns as strings; every amount is still an exact integer and
  // never a float, so no rounding can be introduced by the driver.
  for (const row of amounts.rows) {
    for (const value of Object.values(row)) { expect(String(value)).toMatch(/^-?\d+$/); expect(Number.isInteger(Number(value))).toBe(true); }
  }
  expect(manualInvoiceNumber).toMatch(/^INV-2026-\d{4,}$/);
});
