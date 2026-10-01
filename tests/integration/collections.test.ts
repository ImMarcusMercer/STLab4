import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../source/api/app';
import { AuthService } from '../../source/api/auth/service';
import { seedSecurity } from '../../database/seed-security';
import { createTestDatabase } from '../helpers/database';
import { batchSummary, BatchDetailSchema, BatchListSchema, RouteSheetSchema, type Batch, type BatchDetail } from '../../source/shared/collections';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof buildApp>;
let proofDirectory = '';
let owner = ''; let supervisor = ''; let auditor = ''; let technician = ''; let cashier = '';
const password = 'Synthetic-Collection-Password-123!';
const plan = { code: 'COL999', name: 'Internet 999', serviceType: 'INTERNET', priceCentavos: 99900, installationFeeCentavos: 100000, reconnectionFeeCentavos: 10000, description: '', speedMbps: 100, channelCount: null, active: true };
const headers = (token = owner) => ({ authorization: `Bearer ${token}` });
const get = async (url: string, token = owner) => app.inject({ url: `/api/v1${url}`, headers: headers(token) });
const post = async (url: string, payload: Record<string, unknown> = {}, token = owner) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: headers(token), payload });
const create = (resource: string, data: unknown, token = owner) => post(`/${resource}`, { data, reason: 'Collection fixture' }, token);
const batch = async (id: string, token = owner) => BatchDetailSchema.parse((await get(`/collections/batches/${id}`, token)).json());
const listed = async (query = '', token = owner) => BatchListSchema.parse((await get(`/collections/batches${query}`, token)).json());
const rows = async (sql: string, values: unknown[] = []) => (await db.pool.query(sql, values)).rows;
const attempt = async (statement: string, values: unknown[] = []) => db.pool.query(statement, values).then(() => 'allowed', (error: { message: string }) => error.message);
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
const proof = { fileName: 'route-gcash.png', mimeType: 'image/png', base64: png.toString('base64') };

// Every date comes from the server clock, so a run at any time of day settles the same way:
// the cycle is issued in the coming month, which keeps its due dates ahead of today.
const clock = new Date();
const iso = (date: Date) => date.toISOString().slice(0, 10);
const today = iso(clock);
const addDays = (days: number) => iso(new Date(clock.getTime() + days * 86_400_000));
const cyclePeriod = addDays(45).slice(0, 7);

type Pair = { areaId: string; collectorId: string; areaName: string; collectorName: string; subscriberIds: string[] };
const pairs: Pair[] = [];
let handed = 0;
let emptyAreaId = ''; let outsiderAreaId = ''; let outsiderSubscriberId = ''; let ownerId = ''; let supervisorId = '';
let shortageBatchId = ''; let workingPair = {} as Pair; let arrearsSubscriberId = '';

/**
 * A route is one collector in one area on one day, and an account can only be collected on a
 * route while it still owes something. So every part of this file takes a fresh collector, a
 * fresh area and a fresh owing subscriber, which keeps each test independent of the others.
 */
const nextPair = () => pairs[handed++]!;
const openRoute = async (pair: Pair, subscriberIds?: string[], token = owner) => {
  const response = await post('/collections/batches', { areaId: pair.areaId, collectorId: pair.collectorId, collectionDate: today, ...(subscriberIds ? { subscriberIds } : {}) }, token);
  if (response.statusCode !== 201) throw new Error(`route for ${pair.areaName} was refused with ${response.statusCode}: ${response.body}`);
  return BatchDetailSchema.parse(response.json());
};

beforeAll(async () => {
  proofDirectory = await mkdtemp(join(tmpdir(), 'bcis-collection-'));
  process.env.BCIS_PROOF_DIR = proofDirectory;
  db = await createTestDatabase();
  await seedSecurity(db.pool, { username: 'owner', displayName: 'Owner', password });
  const auth = new AuthService(db.pool);
  owner = (await auth.login('owner', password)).token;
  ownerId = (await rows('SELECT id FROM users WHERE username=$1', ['owner']))[0].id as string;
  for (const [username, role] of [['cashier', 'CASHIER'], ['supervisor', 'SUPERVISOR'], ['auditor', 'AUDITOR'], ['technician', 'TECHNICIAN']] as const) await auth.createUser(owner, { username, displayName: username, password, roles: [role] });
  cashier = (await auth.login('cashier', password)).token;
  supervisor = (await auth.login('supervisor', password)).token;
  supervisorId = (await rows('SELECT id FROM users WHERE username=$1', ['supervisor']))[0].id as string;
  auditor = (await auth.login('auditor', password)).token;
  technician = (await auth.login('technician', password)).token;
  app = buildApp({ checkDatabase: async () => undefined, auth, logLevel: 'silent' });

  emptyAreaId = (await create('areas', { code: 'COLA00', name: 'Nothing owed here', description: '', active: true })).json().id;
  outsiderAreaId = (await create('areas', { code: 'COLA90', name: 'Another barangay', description: '', active: true })).json().id;
  const planId = (await create('plans', plan)).json().id;
  // Three routes need more than one account, so those areas carry two owing subscribers.
  const counts = [2, 1, 2, 2, ...Array.from({ length: 11 }, () => 1)];
  for (const [index, count] of counts.entries()) {
    const areaName = `Barangay ${index + 1}`;
    const collectorName = `Collector ${index + 1}`;
    const areaId = (await create('areas', { code: `COLA${String(index + 1).padStart(2, '0')}`, name: areaName, description: '', active: true })).json().id;
    const collectorId = (await create('collectors', { code: `COLC${String(index + 1).padStart(2, '0')}`, name: collectorName, contact: '09181234567', notes: '', active: true })).json().id;
    const subscriberIds: string[] = [];
    for (const member of Array.from({ length: count }, (_, position) => position)) {
      const code = `COLS${index + 1}${member + 1}`;
      const subscriberId = (await create('subscribers', { code, name: `Sample ${index + 1}-${member + 1}`, contact: '09179876543', email: '', addresses: [`${code} Malaybalay`], areaId, collectorId, billingDay: 1, dueDay: 5, status: 'ACTIVE', notes: '' })).json().id;
      subscriberIds.push(subscriberId);
      await create('services', { code: `${code}SVC`, subscriberId, planId, installationAddress: `${code} Malaybalay`, activationDate: '2026-01-01', billingStartDate: '2026-01-01', billingDay: 1, dueDay: 5, currentRateCentavos: 50000, status: 'ACTIVE', areaId, collectorId, notes: '' });
    }
    pairs.push({ areaId, collectorId, areaName, collectorName, subscriberIds });
    if (index === 0) arrearsSubscriberId = subscriberIds[0]!;
  }
  // A member of a different barangay, who must never appear on a route in the areas above.
  outsiderSubscriberId = (await create('subscribers', { code: 'COLS999', name: 'Outsider', contact: '09179876543', email: '', addresses: ['COLS999 address'], areaId: outsiderAreaId, collectorId: pairs[0]!.collectorId, billingDay: 1, dueDay: 5, status: 'ACTIVE', notes: '' })).json().id;
  await create('services', { code: 'COLS999SVC', subscriberId: outsiderSubscriberId, planId, installationAddress: 'COLS999 address', activationDate: '2026-01-01', billingStartDate: '2026-01-01', billingDay: 1, dueDay: 5, currentRateCentavos: 50000, status: 'ACTIVE', areaId: outsiderAreaId, collectorId: pairs[0]!.collectorId, notes: '' });
  await post('/billing/runs', { period: cyclePeriod, asOf: today });
  // An extra charge that fell due earlier, so one route has arrears as well as a current bill.
  const arrearsService = (await rows('SELECT id FROM service_accounts WHERE code=$1', ['COLS11SVC']))[0].id as string;
  const arrearsDraft = await post('/billing/invoices', { serviceAccountId: arrearsService, issueDate: addDays(-40), dueDate: addDays(-10), items: [{ itemType: 'SUBSCRIPTION', description: 'Earlier unpaid charge', quantity: 1, unitPriceCentavos: 25000 }] });
  expect(arrearsDraft.statusCode).toBe(201);
  expect((await post(`/billing/invoices/${arrearsDraft.json().id}/finalize`, { reason: 'Earlier charge left unpaid' })).statusCode).toBe(200);
  // The route is built from open balances, so the fixture's own cycle has to exist first.
  const billed = (await (await get('/billing/invoices?perPage=100')).json()).items.filter((row: { serviceCode: string }) => row.serviceCode.startsWith('COLS'));
  expect(billed.length).toBeGreaterThanOrEqual(pairs.reduce((total, pair) => total + pair.subscriberIds.length, 0));
});

afterAll(async () => {
  await app?.close();
  await db?.close();
  await rm(proofDirectory, { recursive: true, force: true });
});

/** The figures the API reported must equal the ones recomputed from the same frozen lines. */
const agreesWith = (value: BatchDetail) => {
  const summary = batchSummary(
    value.accounts.map((account) => ({ totalDueCentavos: account.totalDueCentavos, collectedCentavos: account.collectedCentavos })),
    { expectedReceivableCentavos: value.expectedReceivableCentavos, cashCollectedCentavos: value.cashCollectedCentavos, nonCashCollectedCentavos: value.nonCashCollectedCentavos, pendingClaimCentavos: value.pendingClaimCentavos },
  );
  expect({ ...summary, totalCollectedCentavos: value.totalCollectedCentavos }).toMatchObject(summary);
  expect(value.expectedReceivableCentavos).toBe(value.accounts.reduce((total, account) => total + account.totalDueCentavos, 0));
};

describe('collection permissions', () => {
  it('refuses anonymous, unauthorized and unauthorized-by-role requests', async () => {
    expect((await app.inject('/api/v1/collections/batches')).statusCode).toBe(401);
    expect((await get('/collections/batches', technician)).statusCode).toBe(403);
    expect((await get('/collections/batches', supervisor)).statusCode).toBe(200);
    // A cashier records payments but never manages routes, and an auditor reads the ledger and
    // the reports rather than a collector's sheet.
    expect((await get('/collections/batches', cashier)).statusCode).toBe(403);
    expect((await get('/collections/batches', auditor)).statusCode).toBe(403);
    expect((await post('/collections/batches', { areaId: outsiderAreaId, collectorId: pairs[0]!.collectorId, collectionDate: today }, cashier)).statusCode).toBe(403);
    expect((await app.inject('/api/v1/collections/batches/11111111-1111-4111-8111-111111111111/route-sheet')).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/collections/batches/11111111-1111-4111-8111-111111111111', headers: headers() })).statusCode).toBe(404);
  });
});

describe('opening a route', () => {
  it('freezes the accounts and the amounts due for the day', async () => {
    const value = await openRoute(nextPair());
    expect(value.status).toBe('OPEN');
    expect(value.batchNumber).toMatch(/^BCH-\d{4}-\d{4}$/);
    expect(value.areaName).toBe(pairs[0]!.areaName);
    expect(value.collectorName).toBe(pairs[0]!.collectorName);
    // Only the area members with an open balance, never the subscriber in the other barangay.
    expect(value.accounts).toHaveLength(2);
    const current = value.accounts.find((account) => account.subscriberId === arrearsSubscriberId)!;
    const fresh = value.accounts.find((account) => account.subscriberId !== arrearsSubscriberId)!;
    // The newest open invoice is the current bill and the older one is arrears, both frozen in.
    expect(current.currentBillCentavos).toBe(50000);
    expect(current.arrearsCentavos).toBe(25000);
    expect(current.totalDueCentavos).toBe(75000);
    expect(fresh.arrearsCentavos).toBe(0);
    expect(fresh.totalDueCentavos).toBe(50000);
    expect(value.expectedReceivableCentavos).toBe(125000);
    expect(value.cashCollectedCentavos).toBe(0);
    expect(value.balanced).toBe(false);
    expect(value.accounts.every((account) => account.status === 'PENDING')).toBe(true);
    agreesWith(value);
  });

  it('refuses a duplicate route, a future date, an area with nothing due and a bad collector', async () => {
    const pair = nextPair();
    expect((await post('/collections/batches', { areaId: pair.areaId, collectorId: pair.collectorId, collectionDate: today })).statusCode).toBe(201);
    expect((await post('/collections/batches', { areaId: pair.areaId, collectorId: pair.collectorId, collectionDate: today })).statusCode).toBe(409);
    expect((await post('/collections/batches', { areaId: pair.areaId, collectorId: pair.collectorId, collectionDate: addDays(2) })).statusCode).toBe(422);
    expect((await post('/collections/batches', { areaId: emptyAreaId, collectorId: pair.collectorId, collectionDate: today })).statusCode).toBe(409);
    expect((await post('/collections/batches', { areaId: pair.areaId, collectorId: pair.collectorId })).statusCode).toBe(422);
    expect((await post('/collections/batches', { areaId: pair.areaId, collectorId: pair.collectorId, collectionDate: today, subscriberIds: [] })).statusCode).toBe(422);
    expect((await post('/collections/batches', { areaId: pair.areaId, collectorId: pair.collectorId, collectionDate: today, unexpected: true })).statusCode).toBe(422);
  });

  it('narrows the route to a chosen list of accounts', async () => {
    const pair = nextPair();
    const value = await openRoute(pair, [pair.subscriberIds[1]!]);
    expect(value.accounts).toHaveLength(1);
    expect(value.accounts[0]!.subscriberId).toBe(pair.subscriberIds[1]);
    expect(value.expectedReceivableCentavos).toBe(50000);
    // A chosen list is checked against the area, so a subscriber from elsewhere is refused.
    expect((await post('/collections/batches', { areaId: pair.areaId, collectorId: pair.collectorId, collectionDate: today, subscriberIds: [outsiderSubscriberId] })).statusCode).toBe(409);
    // The chosen list is answered first, so naming an account in an empty area is a bad field.
    expect((await post('/collections/batches', { areaId: emptyAreaId, collectorId: pair.collectorId, collectionDate: today, subscriberIds: [outsiderSubscriberId] })).statusCode).toBe(422);
    expect((await post('/collections/batches', { areaId: pair.areaId, collectorId: pair.collectorId, collectionDate: addDays(1), subscriberIds: [pair.subscriberIds[1]!, 'not-a-uuid'] })).statusCode).toBe(422);
  });
});

describe('collecting on a route', () => {
  let route = {} as BatchDetail;
  const first = () => workingPair.subscriberIds[0]!;
  const second = () => workingPair.subscriberIds[1]!;
  beforeAll(async () => {
    workingPair = nextPair();
    route = await openRoute(workingPair);
  });

  it('moves an open route to in progress the first time money is collected', async () => {
    const recorded = await post('/payments', { subscriberId: first(), method: 'CASH', amountCentavos: 50000, receivedOn: today, collectionBatchId: route.id });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json().payment.collectionBatchNumber).toBe(route.batchNumber);
    const value = await batch(route.id);
    expect(value.status).toBe('IN_PROGRESS');
    expect(value.startedAt).not.toBeNull();
    expect(value.cashCollectedCentavos).toBe(50000);
    expect(value.accounts.find((account) => account.subscriberId === first())?.status).toBe('COLLECTED');
    agreesWith(value);
  });

  it('shows a partial payment as partial and keeps the rest uncollected', async () => {
    await post('/payments', { subscriberId: second(), method: 'CASH', amountCentavos: 20000, receivedOn: today, collectionBatchId: route.id });
    const value = await batch(route.id);
    expect(value.accounts.find((account) => account.subscriberId === second())?.status).toBe('PARTIAL');
    expect(value.cashCollectedCentavos).toBe(70000);
    expect(value.uncollectedCentavos).toBe(30000);
    expect(value.totalCollectedCentavos).toBe(70000);
    agreesWith(value);
  });

  it('accepts a GCash claim on the route but does not count it until it is confirmed', async () => {
    const claim = await post('/payments', { subscriberId: second(), method: 'GCASH', amountCentavos: 30000, receivedOn: today, referenceNumber: 'GC-ROUTE-1', collectionBatchId: route.id, proof });
    expect(claim.statusCode).toBe(201);
    expect(claim.json().payment.status).toBe('PENDING');
    const value = await batch(route.id);
    expect(value.cashCollectedCentavos).toBe(70000);
    expect(value.nonCashCollectedCentavos).toBe(0);
    expect(value.pendingClaimCentavos).toBe(30000);
    // A pending claim is a real collection attempt, so the route cannot be handed in as finished.
    expect((await post(`/collections/batches/${route.id}/submit`, { notes: 'Trying early' })).statusCode).toBe(409);
  });

  it('counts a confirmed claim and closes the gap on the account', async () => {
    const claimId = (await (await get('/payments?method=GCASH&status=PENDING&perPage=100')).json()).items[0].id as string;
    // Confirming a claim is a payment act, so it is a cashier or an owner, not a supervisor.
    const confirmed = await post(`/payments/${claimId}/verify`, { notes: 'Confirmed against the remittance' }, cashier);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().payment.status).toBe('POSTED');
    const value = await batch(route.id);
    expect(value.nonCashCollectedCentavos).toBe(30000);
    expect(value.pendingClaimCentavos).toBe(0);
    expect(value.cashCollectedCentavos).toBe(70000);
    expect(value.uncollectedCentavos).toBe(0);
    expect(value.accounts.every((account) => account.status === 'COLLECTED')).toBe(true);
    agreesWith(value);
  });

  it('reports the same figures in the list as in the detail', async () => {
    const value = await batch(route.id);
    const found = (await listed('?perPage=100')).items.find((row: Batch) => row.id === route.id)!;
    for (const key of ['status', 'batchNumber', 'expectedReceivableCentavos', 'cashCollectedCentavos', 'nonCashCollectedCentavos', 'pendingClaimCentavos', 'totalCollectedCentavos', 'uncollectedCentavos', 'overCollectedCentavos', 'accountCount', 'accountsCollected', 'accountsPartial', 'accountsUnpaid', 'shortageCentavos', 'overageCentavos', 'balanced'] as const) {
      expect(found[key], `list and detail disagree on ${key}`).toEqual(value[key]);
    }
  });
});

describe('submitting and counting a remittance', () => {
  let route = {} as BatchDetail;
  beforeAll(async () => {
    const pair = nextPair();
    route = await openRoute(pair);
    await post('/payments', { subscriberId: pair.subscriberIds[0], method: 'CASH', amountCentavos: 50000, receivedOn: today, collectionBatchId: route.id });
  });

  it('refuses to skip a step or to move backwards', async () => {
    expect((await post(`/collections/batches/${route.id}/remittance`, { remittedOn: today, cashCentavos: 50000 })).statusCode).toBe(409);
    expect((await post(`/collections/batches/${route.id}/reconcile`, { notes: 'Straight to signed' })).statusCode).toBe(409);
    expect((await post(`/collections/batches/${route.id}/start`)).statusCode).toBe(409);
  });

  it('submits, then records the counted cash', async () => {
    expect((await post(`/collections/batches/${route.id}/submit`, { notes: 'Route finished' })).statusCode).toBe(200);
    const submitted = await batch(route.id);
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.submittedAt).not.toBeNull();
    const counted = await post(`/collections/batches/${route.id}/remittance`, { remittedOn: today, cashCentavos: 50000, notes: 'Counted in the office' }, supervisor);
    expect(counted.statusCode).toBe(200);
    const value = BatchDetailSchema.parse(counted.json());
    expect(value.status).toBe('REMITTED');
    expect(value.remittance?.remittanceNumber).toMatch(/^RMT-\d{4}-\d{4}$/);
    expect(value.remittance?.expectedCashCentavos).toBe(50000);
    expect(value.balanced).toBe(true);
    expect(value.shortageCentavos).toBe(0);
    expect(value.overageCentavos).toBe(0);
    // One route has one remittance, counted once.
    expect((await post(`/collections/batches/${route.id}/remittance`, { remittedOn: today, cashCentavos: 50000 })).statusCode).toBe(409);
  });

  it('accepts a nil remittance for a route where nothing was collected', async () => {
    const pair = nextPair();
    const empty = await openRoute(pair);
    expect(empty.expectedReceivableCentavos).toBe(50000);
    await post(`/collections/batches/${empty.id}/start`);
    await post(`/collections/batches/${empty.id}/submit`, { notes: 'Nobody was home' });
    const counted = await post(`/collections/batches/${empty.id}/remittance`, { remittedOn: today, cashCentavos: 0, notes: 'Nothing collected' });
    expect(counted.statusCode).toBe(200);
    const value = BatchDetailSchema.parse(counted.json());
    expect(value.balanced).toBe(true);
    expect(value.remittance?.expectedCashCentavos).toBe(0);
    expect(value.uncollectedCentavos).toBe(50000);
  });
});

describe('AT-07 and AT-08: a remittance that does not match', () => {
  it('stores a shortage explicitly and never adjusts it away', async () => {
    const pair = nextPair();
    const route = await openRoute(pair);
    await post('/payments', { subscriberId: pair.subscriberIds[0], method: 'CASH', amountCentavos: 50000, receivedOn: today, collectionBatchId: route.id });
    await post(`/collections/batches/${route.id}/submit`, { notes: '' });
    const counted = await post(`/collections/batches/${route.id}/remittance`, { remittedOn: today, cashCentavos: 49500, notes: 'Two notes short' }, supervisor);
    expect(counted.statusCode).toBe(200);
    const value = BatchDetailSchema.parse(counted.json());
    expect(value.status).toBe('REMITTED');
    expect(value.balanced).toBe(false);
    expect(value.shortageCentavos).toBe(500);
    expect(value.overageCentavos).toBe(0);
    expect(value.remittance?.expectedCashCentavos).toBe(50000);
    expect(value.remittance?.cashCentavos).toBe(49500);
    // The expected figure is frozen against the route, so the difference cannot drift later.
    expect((await rows('SELECT expected_cash_centavos,cash_centavos,balanced FROM batch_remittances WHERE batch_id=$1', [route.id]))[0]).toMatchObject({ expected_cash_centavos: 50000, cash_centavos: 49500, balanced: false });
  });

  it('stores an overage explicitly as well', async () => {
    const pair = nextPair();
    const route = await openRoute(pair);
    await post('/payments', { subscriberId: pair.subscriberIds[0], method: 'CASH', amountCentavos: 50000, receivedOn: today, collectionBatchId: route.id });
    await post(`/collections/batches/${route.id}/submit`, { notes: '' });
    const counted = await post(`/collections/batches/${route.id}/remittance`, { remittedOn: today, cashCentavos: 50500 }, supervisor);
    const over = BatchDetailSchema.parse(counted.json());
    expect(over.balanced).toBe(false);
    expect(over.overageCentavos).toBe(500);
    expect(over.shortageCentavos).toBe(0);
  });

  it('refuses a negative, fractional or future count', async () => {
    const pair = nextPair();
    const route = await openRoute(pair);
    await post(`/collections/batches/${route.id}/start`);
    await post(`/collections/batches/${route.id}/submit`, { notes: '' });
    expect((await post(`/collections/batches/${route.id}/remittance`, { remittedOn: today, cashCentavos: -1 })).statusCode).toBe(422);
    expect((await post(`/collections/batches/${route.id}/remittance`, { remittedOn: today, cashCentavos: 10.5 })).statusCode).toBe(422);
    expect((await post(`/collections/batches/${route.id}/remittance`, { remittedOn: addDays(1), cashCentavos: 0 })).statusCode).toBe(422);
  });
});

describe('reconciliation and closing', () => {
  let balancedId = ''; let shortId = '';
  beforeAll(async () => {
    const shortPair = nextPair();
    const short = await openRoute(shortPair);
    await post('/payments', { subscriberId: shortPair.subscriberIds[0], method: 'CASH', amountCentavos: 50000, receivedOn: today, collectionBatchId: short.id });
    await post(`/collections/batches/${short.id}/submit`, { notes: '' });
    // The owner counts it, so the owner may not be the one who signs it off.
    await post(`/collections/batches/${short.id}/remittance`, { remittedOn: today, cashCentavos: 49000, notes: 'Short by a hundred' }, owner);
    shortId = shortageBatchId = short.id;
    const pair = nextPair();
    const balanced = await openRoute(pair);
    await post('/payments', { subscriberId: pair.subscriberIds[0], method: 'CASH', amountCentavos: 50000, receivedOn: today, collectionBatchId: balanced.id });
    await post(`/collections/batches/${balanced.id}/submit`, { notes: '' });
    await post(`/collections/batches/${balanced.id}/remittance`, { remittedOn: today, cashCentavos: 50000 }, supervisor);
    // The supervisor counted this one, so the owner is the second signature.
    await post(`/collections/batches/${balanced.id}/reconcile`, { notes: 'Counted and agreed in full' }, owner);
    balancedId = balanced.id;
  });

  it('refuses a reconciliation without a written reason', async () => {
    expect((await post(`/collections/batches/${shortId}/reconcile`, { notes: '' })).statusCode).toBe(422);
    expect((await post(`/collections/batches/${shortId}/reconcile`, { notes: 'ok' })).statusCode).toBe(422);
  });

  it('refuses a signer who counted the cash, and keeps the shortage on the record', async () => {
    expect((await post(`/collections/batches/${shortId}/reconcile`, { notes: 'Signed by the counter' }, owner)).statusCode).toBe(403);
    expect((await rows('SELECT recorded_by FROM batch_remittances WHERE batch_id=$1', [shortId]))[0].recorded_by).toBe(ownerId);
    const signed = await post(`/collections/batches/${shortId}/reconcile`, { notes: 'Shortage of 100.00 explained by a torn note' }, supervisor);
    expect(signed.statusCode).toBe(200);
    const value = BatchDetailSchema.parse(signed.json());
    expect(value.status).toBe('RECONCILED');
    expect(value.shortageCentavos).toBe(1000);
    expect(value.reconciledName).toBe('supervisor');
    expect(value.reconciliationNotes).toContain('torn note');
    // Reconciling explains the difference; it never changes the amounts that were counted.
    expect(value.remittance?.cashCentavos).toBe(49000);
    expect((await rows('SELECT reconciled_by FROM collection_batches WHERE id=$1', [shortId]))[0].reconciled_by).toBe(supervisorId);
  });

  it('refuses a second reconciliation and a second remittance', async () => {
    expect((await post(`/collections/batches/${shortId}/reconcile`, { notes: 'Trying again' }, supervisor)).statusCode).toBe(409);
    expect((await post(`/collections/batches/${shortId}/remittance`, { remittedOn: today, cashCentavos: 50000 })).statusCode).toBe(409);
  });

  it('closes only after the reconciliation, and a closed route takes nothing further', async () => {
    expect((await post(`/collections/batches/${shortId}/close`, {})).statusCode).toBe(200);
    expect((await post(`/collections/batches/${balancedId}/close`, {})).statusCode).toBe(200);
    const closed = await batch(balancedId);
    expect(closed.status).toBe('CLOSED');
    expect(closed.closedAt).not.toBeNull();
    expect(closed.reconciledAt).not.toBeNull();
    expect((await post(`/collections/batches/${balancedId}/close`, {})).statusCode).toBe(409);
    expect((await post(`/collections/batches/${balancedId}/submit`, { notes: '' })).statusCode).toBe(409);
  });

  it('refuses a collection on a closed route and a cashier signing a sheet off', async () => {
    const account = (await batch(balancedId)).accounts[0]!;
    expect((await post('/payments', { subscriberId: account.subscriberId, method: 'CASH', amountCentavos: 100, receivedOn: today, collectionBatchId: balancedId })).statusCode).toBe(409);
    expect((await post(`/collections/batches/${shortId}/reconcile`, { notes: 'Cashier attempt' }, cashier)).statusCode).toBe(403);
    expect((await post(`/collections/batches/${shortId}/close`, {}, cashier)).statusCode).toBe(403);
  });
});

describe('the printable route sheet', () => {
  it('is a read-only projection of the stored route', async () => {
    const value = await batch(shortageBatchId);
    const response = await get(`/collections/batches/${value.id}/route-sheet`);
    expect(response.statusCode).toBe(200);
    const sheet = RouteSheetSchema.parse(response.json());
    expect(sheet.batchNumber).toBe(value.batchNumber);
    expect(sheet.collectorName).toBe(value.collectorName);
    expect(sheet.areaName).toBe(value.areaName);
    expect(sheet.collectionDate).toBe(value.collectionDate);
    expect(sheet.accounts.map((account) => account.id)).toEqual(value.accounts.map((account) => account.id));
    expect(sheet.totals.expectedReceivableCentavos).toBe(value.expectedReceivableCentavos);
    expect(sheet.totals.cashCollectedCentavos).toBe(value.cashCollectedCentavos);
    expect(sheet.totals.uncollectedCentavos).toBe(value.uncollectedCentavos);
    expect(sheet.totals.accountCount).toBe(value.accountCount);
    // The sheet is a document, not a command: it answers to no write route at all.
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/collections/batches/${value.id}/route-sheet`, headers: headers(), payload: { totals: { uncollectedCentavos: 0 } } })).statusCode).toBe(404);
  });

  it('filters the list by status, collector and area, and searches the route', async () => {
    const open = (await listed('?status=OPEN&perPage=100')).items;
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((row: Batch) => row.status === 'OPEN')).toBe(true);
    const byCollector = (await listed(`?collectorId=${workingPair.collectorId}&perPage=100`)).items;
    expect(byCollector).toHaveLength(1);
    expect(byCollector[0]!.collectorId).toBe(workingPair.collectorId);
    const byArea = (await listed(`?areaId=${workingPair.areaId}&perPage=100`)).items;
    expect(byArea).toHaveLength(1);
    expect(byArea[0]!.areaId).toBe(workingPair.areaId);
    const searched = (await listed(`?q=${workingPair.areaName}`)).items;
    expect(searched).toHaveLength(1);
  });
});

describe('the database refuses to skip the workflow', () => {
  it('blocks a direct state change without the collection marker', async () => {
    const route = await openRoute(nextPair());
    expect(await attempt("UPDATE collection_batches SET status='CLOSED',closed_at=now() WHERE id=$1", [route.id])).toContain('batch state is append-only');
    expect(await attempt("UPDATE collection_batches SET submitted_at=now() WHERE id=$1", [route.id])).toContain('batch state is append-only');
    expect((await batch(route.id)).status).toBe('OPEN');
  });

  it('blocks a skipped step even inside a marked transaction', async () => {
    const route = await openRoute(nextPair());
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('bcis.collection','on',true)");
      await client.query("UPDATE collection_batches SET status='REMITTED',remitted_at=now() WHERE id=$1", [route.id]);
      await client.query('COMMIT');
      throw new Error('a skipped step was allowed');
    } catch (error) {
      if ((error as Error).message === 'a skipped step was allowed') throw error;
      expect((error as Error).message).toContain('bcis_invalid_transition');
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    expect((await batch(route.id)).status).toBe('OPEN');
  });

  it('keeps the frozen route and the counted remittance out of reach of updates and deletes', async () => {
    const pair = nextPair();
    const route = await openRoute(pair);
    const line = (await rows('SELECT id FROM batch_accounts WHERE batch_id=$1 LIMIT 1', [route.id]))[0].id as string;
    expect(await attempt('UPDATE batch_accounts SET total_due_centavos=0 WHERE id=$1', [line])).toContain('the frozen route of a collection batch cannot be changed');
    expect(await attempt('DELETE FROM batch_accounts WHERE id=$1', [line])).toContain('the frozen route of a collection batch cannot be changed');
    await post('/payments', { subscriberId: pair.subscriberIds[0], method: 'CASH', amountCentavos: 50000, receivedOn: today, collectionBatchId: route.id });
    await post(`/collections/batches/${route.id}/submit`, { notes: '' });
    const counted = await post(`/collections/batches/${route.id}/remittance`, { remittedOn: today, cashCentavos: 50000 }, supervisor);
    const remittanceId = BatchDetailSchema.parse(counted.json()).remittance!.id;
    expect(await attempt('UPDATE batch_remittances SET cash_centavos=0 WHERE id=$1', [remittanceId])).toContain('a remittance is a count that happened once');
    expect(await attempt('DELETE FROM batch_remittances WHERE id=$1', [remittanceId])).toContain('a remittance is a count that happened once');
  });

  it('refuses to re-point a payment to another route', async () => {
    const route = await openRoute(nextPair());
    const other = (await rows('SELECT id FROM collection_batches WHERE id<>$1 ORDER BY created_at LIMIT 1', [route.id]))[0].id as string;
    expect((await rows('SELECT id FROM payments WHERE collection_batch_id=$1 LIMIT 1', [route.id]))[0]).toBeUndefined();
    const recorded = (await rows('SELECT id FROM payments WHERE collection_batch_id IS NOT NULL LIMIT 1'))[0].id as string;
    expect(await attempt('UPDATE payments SET collection_batch_id=$1 WHERE id=$2', [other, recorded])).toContain('a recorded payment cannot be edited');
  });
});
