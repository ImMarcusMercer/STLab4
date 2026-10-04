import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../source/api/app';
import { AuthService } from '../../source/api/auth/service';
import { seedSecurity } from '../../database/seed-security';
import { createTestDatabase } from '../helpers/database';

/**
 * The official receipt, end to end.
 *
 * The receipt is the one document that leaves the building, so these tests assert on the
 * bytes rather than on a view model: that the arithmetic printed on the paper is the
 * arithmetic the ledger holds, and that the cases where no receipt may exist are refused
 * rather than approximated.
 *
 * Each shape lives in its own subscriber on purpose. A single subscriber's payments would
 * otherwise land in each other's invoices, and a test that meant to prove a part payment
 * would quietly prove an allocation across several bills instead.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof buildApp>;
let owner = ''; let viewer = ''; let cashier = ''; let technician = '';
const password = 'Synthetic-Receipt-Password-123!';
const headers = (token = owner) => ({ authorization: `Bearer ${token}` });
const post = async (url: string, payload: Record<string, unknown> = {}, token = owner) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: headers(token), payload });
const create = (resource: string, data: unknown) => post(`/${resource}`, { data, reason: 'Receipt fixture' });
const rows = async (sql: string, values: unknown[] = []) => (await db.pool.query(sql, values)).rows;
const receipt = async (id: string, token = owner) => app.inject({ url: `/api/v1/payments/${id}/receipt`, headers: headers(token) });
/** The literal strings the PDF stream carries, so an assertion is about what is printed. */
const printed = (body: Buffer) => body.toString('latin1');

const clock = new Date();
const iso = (date: Date) => date.toISOString().slice(0, 10);
const today = iso(clock);
const addDays = (days: number) => iso(new Date(clock.getTime() + days * 86_400_000));

let areaId = ''; let collectorId = ''; let planId = '';
/** The receipts each case prints. Named for the property under test, not the fixture order. */
let paidInFull = ''; let partPayment = ''; let paidAhead = '';
let gCashClaim = ''; let voidedClaim = ''; let originalOfReversal = ''; let reversalOf = '';
/** A payment that settled more invoices than one receipt page can list. */
let settledTooMany = '';

/** One subscriber with one active service, owing one finalized invoice of the given amount. */
const owing = async (code: string, amountCentavos: number) => {
  const subscriberId = (await create('subscribers', {
    code, name: `Sample ${code}`, contact: '09179876543', email: '', addresses: [`${code} Malaybalay`],
    areaId, collectorId, billingDay: 1, dueDay: 5, status: 'ACTIVE', notes: '',
  })).json().id;
  const serviceAccountId = (await create('services', {
    code: `${code}SVC`, subscriberId, planId, installationAddress: `${code} Malaybalay`,
    activationDate: addDays(-400), billingStartDate: addDays(-400), billingDay: 1, dueDay: 5,
    currentRateCentavos: 50000, status: 'ACTIVE', areaId, collectorId, notes: '',
  })).json().id;
  const invoice = await post('/billing/invoices', {
    serviceAccountId, issueDate: addDays(-10), dueDate: addDays(5),
    items: [{ itemType: 'SUBSCRIPTION', description: `Charge for ${code}`, quantity: 1, unitPriceCentavos: amountCentavos }],
  });
  expect(invoice.statusCode).toBe(201);
  expect((await post(`/billing/invoices/${invoice.json().id}/finalize`, { reason: 'Deliberately unpaid' })).statusCode).toBe(200);
  return { subscriberId, serviceAccountId, invoiceId: invoice.json().id as string };
};

/** Posts a cash payment and returns the response, so a case can assert the split itself. */
const pay = async (subscriberId: string, amountCentavos: number, notes: string) => {
  const response = await post('/payments', { subscriberId, method: 'CASH', amountCentavos, receivedOn: addDays(-2), notes });
  if (response.statusCode !== 201) throw new Error(`Payment refused with ${response.statusCode}: ${response.body}`);
  return response.json();
};

beforeAll(async () => {
  const proofDirectory = await mkdtemp(join(tmpdir(), 'bcis-receipt-'));
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

  areaId = (await create('areas', { code: 'RCPA00', name: 'Barangay Pina', description: '', active: true })).json().id;
  collectorId = (await create('collectors', { code: 'RCPC00', name: 'Collector Receipt', contact: '09181234567', notes: '', active: true })).json().id;
  planId = (await create('plans', {
    code: 'RCP999', name: 'Internet 999', serviceType: 'INTERNET', priceCentavos: 99900, installationFeeCentavos: 100000,
    reconnectionFeeCentavos: 10000, description: '', speedMbps: 100, channelCount: null, active: true,
  })).json().id;

  // Settled exactly, so the applied figure and the invoice line are the same money and the
  // receipt can be checked against the ledger rather than against itself.
  const exact = await owing('RCPAA1', 120_000);
  const exactPayment = await pay(exact.subscriberId, 120_000, 'Paid in full');
  expect(exactPayment.allocatedCentavos).toBe(120_000);
  expect(exactPayment.advanceCentavos).toBe(0);
  paidInFull = exactPayment.payment.id;

  // Part payment: applied plus still owed is the bill, which is the arithmetic the receipt
  // has to make visible without printing the remainder as if it had been received.
  const partial = await owing('RCPAA2', 30_000);
  const partialPayment = await pay(partial.subscriberId, 12_000, 'Part payment on account');
  expect(partialPayment.allocatedCentavos).toBe(12_000);
  expect(partialPayment.advanceCentavos).toBe(0);
  partPayment = partialPayment.payment.id;

  // Paid a month ahead: the receipt carries a held credit, so its lines do not reach its
  // total and the difference is printed rather than lost.
  const ahead = await owing('RCPAA3', 18_000);
  const aheadPayment = await pay(ahead.subscriberId, 25_000, 'Paid a month ahead');
  expect(aheadPayment.allocatedCentavos).toBe(18_000);
  expect(aheadPayment.advanceCentavos).toBe(7_000);
  paidAhead = aheadPayment.payment.id;

  // A payment that settles more invoices than one receipt page can list. The refusal has to be
  // an actionable 422 rather than a 500 or a clipped sheet, so the fixture is built to overflow:
  // one account carrying a bill per month for well over a page of rows.
  const wide = (await create('subscribers', {
    code: 'RCPAW1', name: 'Sample RCPAAW', contact: '09179876543', email: '', addresses: ['RCPAAW Malaybalay'],
    areaId, collectorId, billingDay: 1, dueDay: 5, status: 'ACTIVE', notes: '',
  })).json().id;
  const wideService = (await create('services', {
    code: 'RCPAAWSVC', subscriberId: wide, planId, installationAddress: 'RCPAAW Malaybalay',
    activationDate: addDays(-1200), billingStartDate: addDays(-1200), billingDay: 1, dueDay: 5,
    currentRateCentavos: 50000, status: 'ACTIVE', areaId, collectorId, notes: '',
  })).json().id;
  let wideBilled = 0;
  for (let month = 0; month < 20; month += 1) {
    const invoice = await post('/billing/invoices', {
      serviceAccountId: wideService, issueDate: addDays(-600 + month * 28), dueDate: addDays(-570 + month * 28),
      items: [{ itemType: 'SUBSCRIPTION', description: `Back bill ${month + 1}`, quantity: 1, unitPriceCentavos: 5_000 }],
    });
    expect(invoice.statusCode).toBe(201);
    expect((await post(`/billing/invoices/${invoice.json().id}/finalize`, { reason: 'Deliberately unpaid' })).statusCode).toBe(200);
    wideBilled += 5_000;
  }
  const widePayment = await pay(wide, wideBilled, 'Clears every arrears bill');
  expect(widePayment.allocatedCentavos).toBe(wideBilled);
  settledTooMany = widePayment.payment.id;

  // A claim awaiting a second person: inert, numbered or not, it may not be printed.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
  const claim = await post('/payments', {
    subscriberId: exact.subscriberId, method: 'GCASH', amountCentavos: 4_321, receivedOn: addDays(-1),
    referenceNumber: 'GCASH-RCP-001', notes: 'Claimed in the app',
    proof: { fileName: 'gcash-claim.png', mimeType: 'image/png', base64: png.toString('base64') },
  });
  if (claim.statusCode !== 201) throw new Error(`GCash claim refused with ${claim.statusCode}: ${claim.body}`);
  gCashClaim = claim.json().payment.id;
  expect(await rows('SELECT status FROM payments WHERE id=$1', [gCashClaim])).toEqual([{ status: 'PENDING' }]);

  // A claim that was never confirmed can only be voided: nothing was ever taken, so its
  // document has to say so rather than print the claimed figure as money received.
  const discarded = await owing('RCPAA4', 10_000);
  const toVoid = (await post('/payments', {
    subscriberId: discarded.subscriberId, method: 'GCASH', amountCentavos: 1_111, receivedOn: addDays(-2),
    referenceNumber: 'GCASH-RCP-002', notes: 'Claimed against the wrong account',
    proof: { fileName: 'gcash-claim.png', mimeType: 'image/png', base64: png.toString('base64') },
  })).json().payment.id as string;
  expect((await post(`/payments/${toVoid}/void`, { reason: 'Claimed against the wrong account' })).statusCode).toBe(200);
  expect(await rows('SELECT status FROM payments WHERE id=$1', [toVoid])).toEqual([{ status: 'VOID' }]);
  voidedClaim = toVoid;

  // A posted receipt can only be reversed, which writes its own document with its own number
  // and reopens the invoice it had settled.
  const reversed = await owing('RCPAA5', 40_000);
  const toReverse = (await pay(reversed.subscriberId, 22_222, 'Keyed twice')).payment.id;
  const reversal = await post(`/payments/${toReverse}/reverse`, { reason: 'Keyed twice by mistake' });
  expect(reversal.statusCode).toBe(200);
  expect(await rows('SELECT direction FROM payments WHERE reversal_of_id=$1', [toReverse])).toEqual([{ direction: 'REVERSAL' }]);
  originalOfReversal = toReverse;
  reversalOf = reversal.json().payment.id;
  expect(await rows('SELECT status FROM payments WHERE id=$1', [originalOfReversal])).toEqual([{ status: 'REVERSED' }]);
});

afterAll(async () => {
  await app?.close();
  await db?.close();
  if (process.env.BCIS_PROOF_DIR) await rm(process.env.BCIS_PROOF_DIR, { recursive: true, force: true });
});

describe('the official receipt', () => {
  it('prints a posted receipt whose figures match the payment it is for', async () => {
    const response = await receipt(paidInFull);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    const body = response.rawPayload;
    expect(body.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(body.subarray(-6).toString()).toContain('%%EOF');
    const start = Number(body.toString('latin1').match(/startxref\s+(\d+)/)![1]);
    expect(body.subarray(start, start + 4).toString()).toBe('xref');

    const payment = await app.inject({ url: `/api/v1/payments/${paidInFull}`, headers: headers() });
    expect(payment.statusCode).toBe(200);
    const text = printed(body);
    // The receipt number, the subscriber and the date are copied from the payment rather
    // than re-derived, so the paper and the record cannot name different events.
    expect(text).toContain(payment.json().receiptNumber);
    expect(text).toContain('Sample RCPAA1');
    expect(text).toContain(payment.json().receivedOn);
    expect(text).toContain('OFFICIAL RECEIPT');
    // The money appears once as a figure and once as words, because a receipt that carries
    // only the numeral is a receipt that can be misread by a hand.
    expect(text).toContain('PHP 1,200.00');
    expect(text).toContain('One Thousand Two Hundred Pesos Only');
    // Applied and held credit are separate lines; when the payment is exact the second is a
    // stated zero, so nothing on the page has to be inferred.
    expect(text).toContain('Applied to invoices');
    expect(text).toContain('Held as advance credit');
    for (const allocation of payment.json().allocations) expect(text).toContain(allocation.invoiceNumber);
  });

  it('prints the invoice a part payment settled without pretending the balance was received', async () => {
    const response = await receipt(partPayment);
    expect(response.statusCode).toBe(200);
    const text = printed(response.rawPayload);
    // Applied is the part, total is what changed hands: the same receipt, two honest figures.
    expect(text).toContain('PHP 120.00');
    expect(text).toContain('Part payment on account');
    expect(text).toContain('One Hundred Twenty Pesos Only');
  });

  it('prints the credit an overpayment held, rather than losing the difference', async () => {
    const response = await receipt(paidAhead);
    expect(response.statusCode).toBe(200);
    const text = printed(response.rawPayload);
    // 25,000 collected, 18,000 applied, 7,000 held: three separate printed figures.
    expect(text).toContain('PHP 250.00');
    expect(text).toContain('PHP 180.00');
    expect(text).toContain('PHP 70.00');
  });

  it('refuses a receipt for a GCash claim nobody has confirmed', async () => {
    // AT-05: a claim awaiting a second person has settled nothing and carries no number.
    // Issuing it a document anyway would undo the property the payment service enforces.
    const response = await receipt(gCashClaim);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/not been confirmed/);
  });

  it('prints a voided entry as a document that received nothing', async () => {
    const response = await receipt(voidedClaim);
    expect(response.statusCode).toBe(200);
    const text = printed(response.rawPayload);
    expect(text).toContain('VOID');
    expect(text).toContain('THIS DOCUMENT HAS NO FINANCIAL EFFECT');
    // The claimed figure is on the page next to a zero total, so the discarded amount has a
    // stated reason instead of a blank field that reads like a lost figure.
    expect(text).toContain('Claimed amount');
    expect(text).toContain('PHP 11.11');
    expect(text).toContain('PHP 0.00');
    expect(text).toMatch(/Not yet issued/);
    expect(text).toContain('Claimed against the wrong account');
  });

  it('prints a reversal as money taken back, naming the receipt it reverses', async () => {
    const response = await receipt(reversalOf);
    expect(response.statusCode).toBe(200);
    const text = printed(response.rawPayload);
    expect(text).toContain('REVERSAL RECEIPT');
    expect(text).toContain('REVERSES RECEIPT');
    expect(text).toContain('PHP -222.22');
    expect(text).toContain('Minus Two Hundred Twenty Two Pesos and Twenty Two Centavos');
    // The invoices it reopened are named, so the document says what became payable again.
    expect(text).toContain('Reopened by this reversal');
  });

  it('keeps the original of a reversed receipt printable, marked as reversed', async () => {
    // The document the subscriber was handed on the day still exists and still has its
    // number. Erasing it is the one history rule this system is not allowed to break.
    const response = await receipt(originalOfReversal);
    expect(response.statusCode).toBe(200);
    const text = printed(response.rawPayload);
    expect(text).toContain('REVERSED');
    expect(text).toContain('PHP 222.22');
    expect(text).toContain('Keyed twice');
  });

  it('records who printed the receipt and what it was for', async () => {
    await receipt(paidInFull);
    const logged = await rows("SELECT actor_id,subject_id,details->>'status' AS status FROM audit_logs WHERE action='receipt.print' ORDER BY created_at DESC LIMIT 1");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.subject_id).toBe(paidInFull);
    expect(logged[0]!.status).toBe('POSTED');
    // A refusal is not a print: the 409 above must leave no trace that reads as a receipt.
    await receipt(gCashClaim).catch(() => undefined);
    const refused = await rows("SELECT count(*)::int AS count FROM audit_logs WHERE subject_id=$1 AND action='receipt.print'", [gCashClaim]);
    expect(refused[0]!.count).toBe(0);
  });

  it('requires report.export to write the document, not merely payment.view', async () => {
    // Reading a payment and producing a document from it are separate grants: a supervisor
    // may hand a customer their receipt without holding the whole reporting suite.
    expect((await receipt(paidInFull, viewer)).statusCode).toBe(403);
    expect((await receipt(paidInFull, cashier)).statusCode).toBe(403);
    expect((await receipt(paidInFull, technician)).statusCode).toBe(403);
  });

  it('refuses an unauthenticated request and an unknown payment', async () => {
    expect((await app.inject({ url: `/api/v1/payments/${paidInFull}/receipt` })).statusCode).toBe(401);
    expect((await receipt('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await receipt('not-a-uuid')).statusCode).toBe(422);
  });

  it('refuses any format but PDF', async () => {
    expect((await app.inject({ url: `/api/v1/payments/${paidInFull}/receipt?format=XLSX`, headers: headers() })).statusCode).toBe(422);
  });

  it('refuses a receipt too full to print, and names the document that can hold it', async () => {
    // The renderer knows how many rows one page carries; the route turns that refusal into a
    // 422 with somewhere to go. A clipped sheet or a 500 would leave the cashier with a payment
    // they could neither receipt nor explain.
    const response = await receipt(settledTooMany);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toMatch(/statement of account/);
    expect(response.headers['content-type']).toContain('application/json');
    // A refusal is not a print, so it leaves no audit entry that reads as a receipt handed over.
    const logged = await rows("SELECT count(*)::int AS count FROM audit_logs WHERE action='receipt.print' AND subject_id=$1", [settledTooMany]);
    expect(logged[0]!.count).toBe(0);
  });

  it('names the file after the receipt, with no path in it', async () => {
    const response = await receipt(paidInFull);
    const disposition = response.headers['content-disposition'] ?? '';
    const payment = await app.inject({ url: `/api/v1/payments/${paidInFull}`, headers: headers() });
    expect(disposition).toContain(payment.json().receiptNumber);
    expect(disposition).toMatch(/filename="BCIS-receipt-[^"]+\.pdf"/);
    expect(disposition).not.toContain('/');
    expect(disposition).not.toContain('..');
  });

  it('is never served from a cache', async () => {
    // A receipt is a financial document: a stale copy on a second screen is a wrong document.
    expect((await receipt(paidInFull)).headers['cache-control']).toMatch(/no-store/);
  });

  it('names today in its printed dates, not the clock the request happened on', async () => {
    // A regression guard on the whole chain: if the document ever formatted its own date it
    // would drift from the payment row it is claiming to document.
    const text = printed((await receipt(paidInFull)).rawPayload);
    const payment = await app.inject({ url: `/api/v1/payments/${paidInFull}`, headers: headers() });
    expect(text).toContain(String(payment.json().receivedOn));
    expect(text).toContain(today);
  });
});