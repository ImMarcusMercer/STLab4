import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, it, expect } from 'vitest';
import { buildApp } from '../../source/api/app';
import { AuthService } from '../../source/api/auth/service';
import { seedSecurity } from '../../database/seed-security';
import { createTestDatabase } from '../helpers/database';
import { PaymentDetailSchema, PaymentListSchema, PaymentResultSchema, SubscriberAccountSchema } from '../../source/shared/payments';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof buildApp>;
let proofDirectory = '';
let owner = ''; let cashier = ''; let auditor = ''; let technician = ''; let supervisor = '';
const password = 'Synthetic-Payment-Password-123!';
const plan = { code: 'PAY999', name: 'Internet 999', serviceType: 'INTERNET', priceCentavos: 99900, installationFeeCentavos: 100000, reconnectionFeeCentavos: 10000, description: '', speedMbps: 100, channelCount: null, active: true };
const headers = (token = owner) => ({ authorization: `Bearer ${token}` });
const get = async (url: string, token = owner) => app.inject({ url: `/api/v1${url}`, headers: headers(token) });
const post = async (url: string, payload: Record<string, unknown> = {}, token = owner) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: headers(token), payload });
const create = (resource: string, data: unknown, token = owner) => post(`/${resource}`, { data, reason: 'Payment fixture' }, token);
const invoiceByCode = async (code: string) => (await get('/billing/invoices?perPage=100')).json().items.find((row: { serviceCode: string }) => row.serviceCode === code);
const invoiceById = async (id: string) => (await get(`/billing/invoices/${id}`)).json();
const ledgerOf = async (subscriberId: string) => (await get(`/billing/ledger?subscriberId=${subscriberId}&perPage=200`)).json();
const account = async (subscriberId: string) => SubscriberAccountSchema.parse((await get(`/payments/account?subscriberId=${subscriberId}`)).json());
const pay = async (payload: Record<string, unknown>, token = owner) => post('/payments', payload, token);
const payment = async (id: string, token = owner) => PaymentDetailSchema.parse((await get(`/payments/${id}`, token)).json());
const rows = async (sql: string, values: unknown[] = []) => (await db.pool.query(sql, values)).rows;
const manualInvoice = async (serviceAccountId: string, issueDate: string, dueDate: string, totalCentavos: number) => {
  const draft = await post('/billing/invoices', { serviceAccountId, issueDate, dueDate, items: [{ itemType: 'SUBSCRIPTION', description: `Subscription ${issueDate.slice(0, 7)}`, quantity: 1, unitPriceCentavos: totalCentavos }] });
  return (await post(`/billing/invoices/${draft.json().id}/finalize`, { reason: 'Manual charge' })).json();
};
// A real one-pixel PNG, so the stored bytes and their digest are checked against content
// the server would actually accept.
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
const proof = (fileName = 'gcash-receipt.png') => ({ fileName, mimeType: 'image/png', base64: png.toString('base64') });
const attempt = async (statement: string, values: unknown[] = []) => db.pool.query(statement, values).then(() => 'allowed', (error: { message: string; code: string }) => `${error.code}: ${error.message}`);

// Every date is derived from the server clock, so a run at any time of day settles the
// same way: the cycle is issued in the coming month, which keeps its due dates ahead of
// today, and the payments are all received today.
const clock = new Date();
const iso = (date: Date) => date.toISOString().slice(0, 10);
const today = iso(clock);
const addDays = (days: number) => iso(new Date(clock.getTime() + days * 86_400_000));
const cyclePeriod = addDays(45).slice(0, 7);
const receipt = (value: number) => `RCT-${today.slice(0, 4)}-${String(value).padStart(4, '0')}`;

let subscriberId = ''; let firstServiceId = ''; let secondServiceId = ''; let oldestInvoiceId = ''; let newestInvoiceId = '';
let creditInvoiceId = ''; let secondManualInvoiceId = ''; let ownerId = ''; let auditorUserId = ''; let gcashPaymentId = ''; let postedPaymentId = ''; let pendingClaimId = ''; let reversedPaymentId = '';

beforeAll(async () => {
  proofDirectory = await mkdtemp(join(tmpdir(), 'bcis-proofs-'));
  process.env.BCIS_PROOF_DIR = proofDirectory;
  db = await createTestDatabase();
  await seedSecurity(db.pool, { username: 'owner', displayName: 'Owner', password });
  const auth = new AuthService(db.pool);
  owner = (await auth.login('owner', password)).token;
  ownerId = (await rows('SELECT id FROM users WHERE username=$1', ['owner']))[0].id as string;
  for (const [username, role] of [['cashier', 'CASHIER'], ['auditor', 'AUDITOR'], ['technician', 'TECHNICIAN'], ['supervisor', 'SUPERVISOR']] as const) {
    await auth.createUser(owner, { username, displayName: username, password, roles: [role] });
  }
  cashier = (await auth.login('cashier', password)).token;
  auditor = (await auth.login('auditor', password)).token;
  auditorUserId = (await rows('SELECT id FROM users WHERE username=$1', ['auditor']))[0].id as string;
  technician = (await auth.login('technician', password)).token;
  supervisor = (await auth.login('supervisor', password)).token;
  app = buildApp({ checkDatabase: async () => undefined, auth, logLevel: 'silent' });

  const planId = (await create('plans', plan)).json().id;
  subscriberId = (await create('subscribers', { code: 'PSUB001', name: 'Payment Sample', contact: '09179876543', email: 'payment@example.test', addresses: ['Malaybalay payment address'], areaId: null, collectorId: null, billingDay: 1, dueDay: 5, status: 'ACTIVE', notes: '' })).json().id;
  // Two accounts for one subscriber: the earlier due date is the one a payment must settle.
  firstServiceId = (await create('services', { code: 'PSVC001', subscriberId, planId, installationAddress: 'PSVC001 address', activationDate: '2026-06-01', billingStartDate: '2026-06-01', billingDay: 1, dueDay: 5, currentRateCentavos: 99900, status: 'ACTIVE', areaId: null, collectorId: null, notes: '' })).json().id;
  secondServiceId = (await create('services', { code: 'PSVC002', subscriberId, planId, installationAddress: 'PSVC002 address', activationDate: '2026-07-01', billingStartDate: '2026-07-01', billingDay: 20, dueDay: 25, currentRateCentavos: 35000, status: 'ACTIVE', areaId: null, collectorId: null, notes: '' })).json().id;
  await post('/billing/runs', { period: cyclePeriod, asOf: today });
  oldestInvoiceId = (await invoiceByCode('PSVC001')).id;
  newestInvoiceId = (await invoiceByCode('PSVC002')).id;
});

afterAll(async () => {
  await app?.close();
  await db?.close();
  await rm(proofDirectory, { recursive: true, force: true });
});

it('refuses anonymous, unauthorized and unauthorized-by-role payment requests', async () => {
  expect((await app.inject('/api/v1/payments')).statusCode).toBe(401);
  expect((await get('/payments', technician)).statusCode).toBe(403);
  // A supervisor may not collect, and an auditor may read and reverse but never record.
  expect((await pay({ subscriberId, method: 'CASH', amountCentavos: 100, receivedOn: today }, supervisor)).statusCode).toBe(403);
  expect((await pay({ subscriberId, method: 'CASH', amountCentavos: 100, receivedOn: today }, auditor)).statusCode).toBe(403);
  expect((await get('/payments', auditor)).statusCode).toBe(200);
  expect((await get(`/payments/account?subscriberId=${subscriberId}`, auditor)).statusCode).toBe(200);
  // A cashier records and confirms, but never reverses a posted payment.
  expect((await post('/payments/11111111-1111-4111-8111-111111111111/reverse', { reason: 'Not allowed' }, cashier)).statusCode).toBe(403);
  expect((await post('/payments/11111111-1111-4111-8111-111111111111/verify', { notes: '' }, technician)).statusCode).toBe(403);
  // A posted financial row is never reachable through a destructive route.
  expect((await app.inject({ method: 'DELETE', url: `/api/v1/payments/${newestInvoiceId}`, headers: headers() })).statusCode).toBe(404);
  expect((await app.inject({ method: 'PATCH', url: `/api/v1/payments/${newestInvoiceId}`, headers: headers(), payload: { amountCentavos: 1 } })).statusCode).toBe(404);
});

it('shows the subscriber account with the oldest due date first and the outstanding total', async () => {
  const view = await account(subscriberId);
  expect(view.subscriberCode).toBe('PSUB001');
  expect(view.outstandingCentavos).toBe(134900);
  expect(view.advanceCentavos).toBe(0);
  expect(view.items.map(item => item.invoiceId)).toEqual([oldestInvoiceId, newestInvoiceId]);
  expect(view.items.map(item => item.status)).toEqual(['UNPAID', 'UNPAID']);
});

it('settles an invoice exactly with one payment and issues the first receipt (AT-01, AT-06)', async () => {
  const result = PaymentResultSchema.parse((await pay({ subscriberId, method: 'CASH', amountCentavos: 99900, receivedOn: today })).json());
  expect(result.payment.receiptNumber).toBe(receipt(1001));
  expect(result.payment.status).toBe('POSTED');
  expect(result.allocatedCentavos).toBe(99900);
  expect(result.advanceCentavos).toBe(0);
  expect(result.touched).toEqual([{ invoiceId: oldestInvoiceId, invoiceNumber: expect.stringMatching(/^INV-\d{4}-\d{4,}$/), appliedCentavos: 99900, balanceCentavos: 0, status: 'PAID' }]);
  const settled = await invoiceById(oldestInvoiceId);
  expect(settled.status).toBe('PAID');
  expect(settled.paidCentavos).toBe(99900);
  expect(settled.balanceCentavos).toBe(0);
  // One credit line for the whole payment, so the statement reproduces from its entries.
  const statement = await ledgerOf(subscriberId);
  const paymentLines = statement.items.filter((row: { referenceType: string }) => row.referenceType === 'PAYMENT');
  expect(paymentLines).toHaveLength(1);
  expect(paymentLines[0]).toMatchObject({ referenceNumber: receipt(1001), creditCentavos: 99900, debitCentavos: 0 });
  expect(statement.totalCreditCentavos).toBe(99900);
  expect(statement.totalDebitCentavos).toBe(134900);
  const detail = await payment(result.payment.id);
  expect(detail.allocations).toEqual([expect.objectContaining({ invoiceId: oldestInvoiceId, amountCentavos: 99900, source: 'PAYMENT', reversedAt: null })]);
});

it('applies the next payment to the oldest invoice that is still open (AT-04)', async () => {
  const result = PaymentResultSchema.parse((await pay({ subscriberId, method: 'CASH', amountCentavos: 20000, receivedOn: today })).json());
  expect(result.payment.receiptNumber).toBe(receipt(1002));
  expect(result.allocatedCentavos).toBe(20000);
  expect(result.touched).toEqual([{ invoiceId: newestInvoiceId, invoiceNumber: expect.any(String), appliedCentavos: 20000, balanceCentavos: 15000, status: 'PARTIALLY_PAID' }]);
  const invoice = await invoiceById(newestInvoiceId);
  expect(invoice.status).toBe('PARTIALLY_PAID');
  expect(invoice.paidCentavos).toBe(20000);
  expect(invoice.balanceCentavos).toBe(15000);
});

it('holds the excess of an overpayment as a credit on the account (AT-03)', async () => {
  const result = PaymentResultSchema.parse((await pay({ subscriberId, method: 'CASH', amountCentavos: 100000, receivedOn: today })).json());
  expect(result.payment.receiptNumber).toBe(receipt(1003));
  expect(result.allocatedCentavos).toBe(15000);
  expect(result.advanceCentavos).toBe(85000);
  expect((await invoiceById(newestInvoiceId)).status).toBe('PAID');
  const view = await account(subscriberId);
  expect(view.outstandingCentavos).toBe(0);
  expect(view.advanceCentavos).toBe(85000);
  // The statement shows every centavo received, and the extra money is a credit.
  const statement = await ledgerOf(subscriberId);
  expect(statement.verified).toBe(true);
  expect(statement.totalCreditCentavos).toBe(219900);
  expect(statement.totalDebitCentavos).toBe(134900);
});

it('spends the held credit on the next invoice without a new payment (AT-03)', async () => {
  const invoice = await manualInvoice(firstServiceId, today, addDays(10), 99900);
  expect(invoice.status).toBe('PARTIALLY_PAID');
  expect(invoice.paidCentavos).toBe(85000);
  expect(invoice.balanceCentavos).toBe(14900);
  expect((await account(subscriberId)).advanceCentavos).toBe(0);
  // The credit is reported as settled by credit, never as a cash payment.
  const allocation = await rows("SELECT source,amount_centavos FROM payment_allocations WHERE invoice_id=$1", [invoice.id]);
  expect(allocation).toEqual([{ source: 'ADVANCE', amount_centavos: 85000 }]);
  const source = (await rows('SELECT payment_id FROM payment_allocations WHERE invoice_id=$1 LIMIT 1', [invoice.id]))[0].payment_id as string;
  const detail = await payment(source);
  expect(detail.receiptNumber).toBe(receipt(1003));
  expect(detail.allocations).toEqual(expect.arrayContaining([
    expect.objectContaining({ invoiceId: invoice.id, amountCentavos: 85000, source: 'ADVANCE', reversedAt: null }),
    expect.objectContaining({ invoiceId: newestInvoiceId, amountCentavos: 15000, source: 'PAYMENT', reversedAt: null }),
  ]));
  expect((await ledgerOf(subscriberId)).verified).toBe(true);
  creditInvoiceId = invoice.id;
});

it('settles the oldest open invoice first when one payment covers two (AT-04)', async () => {
  const second = await manualInvoice(secondServiceId, addDays(1), addDays(21), 40000);
  expect(second.status).toBe('UNPAID');
  secondManualInvoiceId = second.id;
  const result = PaymentResultSchema.parse((await pay({ subscriberId, method: 'CASH', amountCentavos: 54900, receivedOn: today })).json());
  expect(result.payment.receiptNumber).toBe(receipt(1004));
  expect(result.allocatedCentavos).toBe(54900);
  expect(result.advanceCentavos).toBe(0);
  expect(result.touched).toEqual([
    // Part of this invoice was already settled from the held credit, so its settled
    // status is CREDITED rather than PAID.
    { invoiceId: creditInvoiceId, invoiceNumber: expect.any(String), appliedCentavos: 14900, balanceCentavos: 0, status: 'CREDITED' },
    { invoiceId: second.id, invoiceNumber: expect.any(String), appliedCentavos: 40000, balanceCentavos: 0, status: 'PAID' },
  ]);
  expect((await account(subscriberId)).outstandingCentavos).toBe(0);
  const settledStatement = await ledgerOf(subscriberId);
  expect(settledStatement.verified).toBe(true);
  expect(settledStatement.totalCreditCentavos).toBe(274800);
  expect(settledStatement.totalDebitCentavos).toBe(274800);
  expect(settledStatement.closingBalanceCentavos).toBe(0);
});

it('refuses a GCash payment that arrives without a reference or a receipt image (AT-05)', async () => {
  const withoutReference = await pay({ subscriberId, method: 'GCASH', amountCentavos: 100, receivedOn: today, proof: proof() }, cashier);
  expect(withoutReference.statusCode).toBe(422);
  expect(withoutReference.json().error.fields.referenceNumber).toBeDefined();
  const withoutProof = await pay({ subscriberId, method: 'GCASH', amountCentavos: 100, receivedOn: today, referenceNumber: 'GCASH-NOPROOF' }, cashier);
  expect(withoutProof.statusCode).toBe(422);
  expect(withoutProof.json().error.fields.proof).toBeDefined();
  // A cash payment has no reference, and a file that is not a receipt image is refused
  // before anything is stored.
  expect((await pay({ subscriberId, method: 'CASH', amountCentavos: 100, receivedOn: today, referenceNumber: 'GCASH-NOPE' })).statusCode).toBe(422);
  const forged = await pay({ subscriberId, method: 'GCASH', amountCentavos: 100, receivedOn: today, referenceNumber: 'GCASH-FORGED', proof: { fileName: 'note.txt', mimeType: 'text/plain', base64: Buffer.from('not a receipt').toString('base64') } }, cashier);
  expect(forged.statusCode).toBe(422);
  expect((await pay({ subscriberId, method: 'CASH', amountCentavos: 100, receivedOn: '2999-01-01' })).statusCode).toBe(422);
  expect((await pay({ subscriberId, method: 'CASH', amountCentavos: 0, receivedOn: today })).statusCode).toBe(422);
  expect((await readdir(proofDirectory)).length).toBe(0);
  expect((await get('/payments/22222222-2222-4222-8222-222222222222')).statusCode).toBe(404);
  expect((await get('/payments/not-a-uuid')).statusCode).toBe(422);
  expect((await get('/payments/account')).statusCode).toBe(422);
  expect((await post(`/payments/22222222-2222-4222-8222-222222222222/verify`, { notes: '' })).statusCode).toBe(404);
});

it('holds a GCash payment as pending until a second person confirms it (AT-05)', async () => {
  const recorded = await pay({ subscriberId, method: 'GCASH', amountCentavos: 40000, receivedOn: today, referenceNumber: 'GCASH-A1B2C3', notes: 'Sent through the app', proof: proof() }, cashier);
  expect(recorded.statusCode).toBe(201);
  const result = PaymentResultSchema.parse(recorded.json());
  const pendingId = result.payment.id;
  expect(result.payment).toMatchObject({ status: 'PENDING', receiptNumber: null, referenceNumber: 'GCASH-A1B2C3', appliedCentavos: 0, advanceCentavos: 0, verifiedBy: null, recordedName: 'cashier' });
  expect(result.allocatedCentavos).toBe(0);
  expect(result.advanceCentavos).toBe(0);
  expect(result.touched).toEqual([]);
  expect(result.payment.proof).toMatchObject({ originalName: 'gcash-receipt.png', mimeType: 'image/png', byteSize: png.length, sha256: createHash('sha256').update(png).digest('hex') });
  // An unverified claim is not money: no receipt, no allocation and no ledger line.
  expect((await payment(pendingId)).allocations).toEqual([]);
  expect((await account(subscriberId)).advanceCentavos).toBe(0);
  expect((await ledgerOf(subscriberId)).items.filter((row: { referenceType: string }) => row.referenceType === 'PAYMENT')).toHaveLength(4);

  // The stored bytes come back only to a signed-in reader, and the path is never exposed.
  expect((await app.inject('/api/v1/payments/' + pendingId + '/proof')).statusCode).toBe(401);
  expect((await get(`/payments/${pendingId}/proof`, technician)).statusCode).toBe(403);
  const attachment = await get(`/payments/${pendingId}/proof`, auditor);
  expect(attachment.statusCode).toBe(200);
  expect(attachment.json()).toEqual({ fileName: 'gcash-receipt.png', mimeType: 'image/png', byteSize: png.length, base64: png.toString('base64') });
  expect(attachment.headers['cache-control']).toBe('no-store');

  // The collector cannot confirm their own entry, and only a verifier may try.
  expect((await post(`/payments/${pendingId}/verify`, { notes: 'Signed by me' }, cashier)).statusCode).toBe(403);
  expect((await post(`/payments/${pendingId}/verify`, { notes: '' }, technician)).statusCode).toBe(403);
  expect((await post(`/payments/${pendingId}/verify`, { notes: 'x'.repeat(600) })).statusCode).toBe(422);

  const confirmed = PaymentResultSchema.parse((await post(`/payments/${pendingId}/verify`, { notes: 'Checked against the app' })).json());
  expect(confirmed.payment).toMatchObject({ status: 'POSTED', receiptNumber: receipt(1005), verifiedName: 'Owner' });
  expect(confirmed.payment.verifiedBy).not.toBeNull();
  expect(confirmed.allocatedCentavos).toBe(0);
  expect(confirmed.advanceCentavos).toBe(40000);
  expect((await account(subscriberId)).advanceCentavos).toBe(40000);
  // Confirming twice is refused, so a payment cannot be posted a second time.
  expect((await post(`/payments/${pendingId}/verify`, { notes: 'Again' })).statusCode).toBe(409);
  const statement = await ledgerOf(subscriberId);
  expect(statement.verified).toBe(true);
  expect(statement.items.filter((row: { referenceType: string }) => row.referenceType === 'PAYMENT')).toHaveLength(5);
  expect(statement.totalCreditCentavos).toBe(314800);
  expect(statement.totalDebitCentavos).toBe(274800);
  gcashPaymentId = pendingId;
});

it('refuses a second claim that reuses a live GCash reference (AT-05)', async () => {
  expect((await readdir(proofDirectory)).length).toBe(1);
  const duplicate = await pay({ subscriberId, method: 'GCASH', amountCentavos: 100, receivedOn: today, referenceNumber: 'GCASH-A1B2C3', proof: proof() }, cashier);
  expect(duplicate.statusCode).toBe(409);
  // The rejected claim leaves no row, no receipt and no file behind.
  expect((await readdir(proofDirectory)).length).toBe(1);
  expect((await account(subscriberId)).advanceCentavos).toBe(40000);
  const found = PaymentListSchema.parse((await get('/payments?q=GCASH-A1B2C3')).json());
  expect(found.total).toBe(1);
  expect(found.items.map(item => item.id)).toEqual([gcashPaymentId]);
  // The claim that owns the reference is untouched by the rejected duplicate.
  expect(await payment(gcashPaymentId)).toMatchObject({ status: 'POSTED', receiptNumber: receipt(1005), referenceNumber: 'GCASH-A1B2C3' });
  expect((await post(`/payments/${gcashPaymentId}/reverse`, { reason: 'x' })).statusCode).toBe(422);
});

it('keeps a voided claim in the history and frees its reference (AT-06)', async () => {
  const recorded = await pay({ subscriberId, method: 'GCASH', amountCentavos: 500, receivedOn: today, referenceNumber: 'GCASH-VOID1', proof: proof('wrong-amount.png') }, cashier);
  expect(recorded.statusCode).toBe(201);
  const claimed = (recorded.json() as { payment: { id: string } }).payment;
  const voided = (await post(`/payments/${claimed.id}/void`, { reason: 'Entered against the wrong subscriber' }, cashier)).json();
  expect(voided).toMatchObject({ status: 'VOID', receiptNumber: null, voidReason: 'Entered against the wrong subscriber' });
  expect(voided.voidedAt).not.toBeNull();
  expect((await post(`/payments/${claimed.id}/void`, { reason: 'Again' }, cashier)).statusCode).toBe(409);
  // Voiding is the collector's own command; an auditor may not discard an entry.
  expect((await post(`/payments/${claimed.id}/void`, { reason: 'Not mine to void' }, auditor)).statusCode).toBe(403);
  expect((await post(`/payments/${claimed.id}/void`, { reason: 'x' }, cashier)).statusCode).toBe(422);
  // The proof and the reference stay in the history of the voided row, and the reference
  // becomes available again because the claim never reached the ledger.
  const detail = await payment(claimed.id);
  expect(detail.status).toBe('VOID');
  expect(detail.appliedCentavos).toBe(0);
  expect(detail.proof).toMatchObject({ originalName: 'wrong-amount.png' });
  const rebooked = await pay({ subscriberId, method: 'GCASH', amountCentavos: 600, receivedOn: today, referenceNumber: 'GCASH-VOID1', proof: proof() }, cashier);
  expect(rebooked.statusCode).toBe(201);
  pendingClaimId = (rebooked.json() as { payment: { id: string } }).payment.id;
  expect((await post(`/payments/${pendingClaimId}/void`, { reason: 'Test claim withdrawn' }, cashier)).statusCode).toBe(200);
  expect((await account(subscriberId)).advanceCentavos).toBe(40000);
});

it('reverses a posted payment with its own receipt and reopens the invoices it settled (AT-06)', async () => {
  const later = PaymentResultSchema.parse((await pay({ subscriberId, method: 'CASH', amountCentavos: 30000, receivedOn: today })).json());
  expect(later.payment.receiptNumber).toBe(receipt(1006));
  expect(later.allocatedCentavos).toBe(0);
  expect(later.advanceCentavos).toBe(30000);
  expect((await account(subscriberId)).advanceCentavos).toBe(70000);
  postedPaymentId = later.payment.id;

  reversedPaymentId = (await rows('SELECT id FROM payments WHERE receipt_number=$1', [receipt(1004)]))[0].id as string;
  const original = await payment(reversedPaymentId);
  expect(original).toMatchObject({ status: 'POSTED', direction: 'PAYMENT', amountCentavos: 54900, appliedCentavos: 54900, advanceCentavos: 0 });
  expect(original.allocations.map(allocation => allocation.invoiceId)).toEqual([creditInvoiceId, secondManualInvoiceId]);

  const reversal = PaymentResultSchema.parse((await post(`/payments/${reversedPaymentId}/reverse`, { reason: 'Cheque was returned by the bank' }, auditor)).json());
  expect(reversal.payment).toMatchObject({
    status: 'POSTED', direction: 'REVERSAL', method: 'CASH', amountCentavos: 54900, appliedCentavos: 54900,
    advanceCentavos: 0, receiptNumber: receipt(1007), reversalOfId: reversedPaymentId, reversalOfReceipt: receipt(1004), recordedName: 'auditor',
  });
  expect(reversal.allocatedCentavos).toBe(54900);
  expect(reversal.touched).toEqual([
    // The part of this invoice that came from the held credit is untouched, so it reopens
    // as partially paid rather than unpaid.
    { invoiceId: creditInvoiceId, invoiceNumber: expect.any(String), appliedCentavos: 14900, balanceCentavos: 14900, status: 'PARTIALLY_PAID' },
    { invoiceId: secondManualInvoiceId, invoiceNumber: expect.any(String), appliedCentavos: 40000, balanceCentavos: 40000, status: 'UNPAID' },
  ]);
  // The original entry keeps its receipt and its allocations, marked as reversed.
  const after = await payment(reversedPaymentId);
  expect(after.status).toBe('REVERSED');
  expect(after.voidReason).toBe('Cheque was returned by the bank');
  expect(after.receiptNumber).toBe(receipt(1004));
  expect(after.allocations.map(allocation => allocation.reversedAt === null)).toEqual([false, false]);
  expect((await invoiceById(creditInvoiceId)).paidCentavos).toBe(85000);
  expect((await invoiceById(creditInvoiceId)).status).toBe('PARTIALLY_PAID');
  expect((await invoiceById(secondManualInvoiceId)).status).toBe('UNPAID');
  const view = await account(subscriberId);
  expect(view.outstandingCentavos).toBe(54900);
  expect(view.advanceCentavos).toBe(70000);
  // The reversal is its own document in the statement, linked to the line it undoes. A
  // negative closing balance is a credit: 70000 held against 54900 reopened.
  const statement = await ledgerOf(subscriberId);
  expect(statement.closingBalanceCentavos).toBe(-15100);
  expect(statement.verified).toBe(true);
  expect(statement.totalCreditCentavos).toBe(344800);
  expect(statement.totalDebitCentavos).toBe(329700);
  const reversalLine = statement.items.find((row: { referenceNumber: string }) => row.referenceNumber === receipt(1007));
  expect(reversalLine).toMatchObject({ referenceType: 'PAYMENT', debitCentavos: 54900, creditCentavos: 0, reversalOfId: expect.any(String) });
  const originalLine = statement.items.find((row: { referenceNumber: string }) => row.referenceNumber === receipt(1004));
  expect(reversalLine.reversalOfId).toBe(originalLine.id);
  expect(statement.items.filter((row: { referenceType: string }) => row.referenceType === 'PAYMENT')).toHaveLength(7);

  // A reversal cannot be reversed, and a claim that never posted cannot be either.
  expect((await post(`/payments/${reversal.payment.id}/reverse`, { reason: 'Back again' }, auditor)).statusCode).toBe(409);
  expect((await post(`/payments/${pendingClaimId}/reverse`, { reason: 'Never posted' }, auditor)).statusCode).toBe(409);
  expect((await post(`/payments/${reversedPaymentId}/void`, { reason: 'Instead of reversing' })).statusCode).toBe(409);
  expect((await post(`/payments/${reversedPaymentId}/reverse`, { reason: 'x' }, auditor)).statusCode).toBe(422);
  const actions = (await rows('SELECT action FROM audit_logs WHERE subject_id=$1 ORDER BY created_at,id', [reversedPaymentId])).map(row => row.action);
  expect(actions).toContain('payment.reverse');
  expect((await rows('SELECT actor_id FROM audit_logs WHERE subject_id=$1 AND action=$2 LIMIT 1', [reversedPaymentId, 'payment.reverse']))[0].actor_id).toBe(auditorUserId);
});

it('lists and filters the payment register', async () => {
  const all = PaymentListSchema.parse((await get('/payments?perPage=100')).json());
  expect(all.total).toBe(all.items.length);
  expect(all.items.map(item => item.id)).toContain(reversedPaymentId);
  expect(all.items.map(item => item.receiptNumber)).toContain(receipt(1007));
  const voided = PaymentListSchema.parse((await get('/payments?status=VOID')).json());
  expect(voided.items.map(item => item.referenceNumber).sort()).toEqual(['GCASH-VOID1', 'GCASH-VOID1']);
  const gcash = PaymentListSchema.parse((await get('/payments?method=GCASH')).json());
  expect(gcash.items).toHaveLength(3);
  expect(gcash.items.every(item => item.method === 'GCASH')).toBe(true);
  const mine = PaymentListSchema.parse((await get(`/payments?subscriberId=${subscriberId}&perPage=2&page=1`)).json());
  expect(mine.items).toHaveLength(2);
  expect(mine.total).toBe(all.total);
  const second = PaymentListSchema.parse((await get(`/payments?subscriberId=${subscriberId}&perPage=2&page=2`)).json());
  expect(second.items.map(item => item.id)).not.toEqual(mine.items.map(item => item.id));
  expect((await get('/payments?status=PAID')).statusCode).toBe(422);
  expect((await get('/payments?perPage=0')).statusCode).toBe(422);
  expect((await get('/payments?perPage=1000')).statusCode).toBe(422);
  const search = PaymentListSchema.parse((await get('/payments?q=PSUB001')).json());
  expect(search.total).toBe(all.total);
  expect(PaymentListSchema.parse((await get('/payments?q=nothing-matches-this')).json()).items).toEqual([]);
  // Every row of the register carries the money it moved, never a negative hold.
  expect(all.items.every(item => item.advanceCentavos >= 0 && item.appliedCentavos >= 0)).toBe(true);
});

it('refuses to change, delete or unbalance a payment outside the service (AT-06)', async () => {
  expect(await attempt('UPDATE payments SET amount_centavos=amount_centavos+1 WHERE id=$1', [reversedPaymentId])).toContain('bcis_immutable_row');
  expect(await attempt('UPDATE payments SET status=$2 WHERE id=$1', [reversedPaymentId, 'VOID'])).toContain('bcis_immutable_row');
  expect(await attempt('UPDATE payments SET received_on=$2 WHERE id=$1', [reversedPaymentId, '2020-01-01'])).toContain('bcis_immutable_row');
  expect(await attempt('DELETE FROM payments WHERE id=$1', [reversedPaymentId])).toContain('bcis_immutable_row');
  expect(await attempt('DELETE FROM payment_allocations WHERE invoice_id=$1', [creditInvoiceId])).toContain('bcis_immutable_row');
  expect(await attempt('UPDATE payment_allocations SET amount_centavos=1 WHERE invoice_id=$1', [creditInvoiceId])).toContain('bcis_immutable_row');
  expect(await attempt("UPDATE payment_proofs SET original_name='other.png' WHERE payment_id=$1", [gcashPaymentId])).toContain('bcis_immutable_row');
  expect(await attempt('DELETE FROM payment_proofs WHERE payment_id=$1', [gcashPaymentId])).toContain('bcis_immutable_row');
  // An allocation may only be reversed by a posting transaction, never edited.
  expect(await attempt('UPDATE payment_allocations SET reversed_at=now() WHERE invoice_id=$1', [creditInvoiceId])).toContain('bcis_immutable_row');
  // A GCash reference stays reserved for a live claim, which is what makes it unique.
  expect(await attempt('INSERT INTO payments(subscriber_id,method,direction,status,amount_centavos,received_on,reference_number,recorded_by,verified_by,verified_at,receipt_number) SELECT subscriber_id,$1,$2,$3,1,current_date,$4,recorded_by,recorded_by,now(),$5 FROM payments WHERE id=$6', [
    'GCASH', 'PAYMENT', 'POSTED', 'GCASH-A1B2C3', receipt(1099), reversedPaymentId,
  ])).toContain('payments_gcash_reference_idx');

  // An allocation that does not move the invoice is refused when the transaction commits.
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('bcis.posting','on',true)");
    await client.query(
      "INSERT INTO payment_allocations(payment_id,invoice_id,source,amount_centavos,actor_id) VALUES($1,$2,'PAYMENT',1,$3)",
      [postedPaymentId, creditInvoiceId, ownerId],
    );
    let failure = 'committed';
    try { await client.query('COMMIT'); } catch (error) {
      failure = (error as { message: string }).message;
      await client.query('ROLLBACK');
    }
    expect(failure).toContain('bcis_allocation_mismatch');
  } finally { client.release(); }
  const invoice = await invoiceById(creditInvoiceId);
  expect(invoice.paidCentavos).toBe(85000);
  expect(invoice.balanceCentavos).toBe(14900);
  const allocations = await rows('SELECT count(*)::int AS total FROM payment_allocations WHERE invoice_id=$1', [creditInvoiceId]);
  expect(allocations[0].total).toBe(2);

  // One receipt can never settle more than the money it received, even when the invoice
  // figures and the allocations are both moved to match.
  const second = await db.pool.connect();
  try {
    await second.query('BEGIN');
    await second.query("SELECT set_config('bcis.posting','on',true)");
    await second.query('UPDATE invoices SET paid_centavos=paid_centavos+$2,balance_centavos=balance_centavos-$2 WHERE id=$1', [secondManualInvoiceId, 30001]);
    await second.query(
      "INSERT INTO payment_allocations(payment_id,invoice_id,source,amount_centavos,actor_id) VALUES($1,$2,'PAYMENT',30001,$3)",
      [postedPaymentId, secondManualInvoiceId, ownerId],
    );
    let failure = 'committed';
    try { await second.query('COMMIT'); } catch (error) {
      failure = (error as { message: string }).message;
      await second.query('ROLLBACK');
    }
    expect(failure).toContain('bcis_allocation_exceeds_payment');
  } finally { second.release(); }
  const unchanged = await invoiceById(creditInvoiceId);
  expect(unchanged.paidCentavos).toBe(85000);
  expect((await invoiceById(secondManualInvoiceId)).paidCentavos).toBe(0);
  expect((await rows('SELECT count(*)::int AS total FROM payment_allocations WHERE payment_id=$1', [postedPaymentId]))[0].total).toBe(0);
});

