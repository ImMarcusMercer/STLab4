import { recordSchema } from '../../source/shared/master-data';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { buildApp } from '../../source/api/app';
import { AuthService } from '../../source/api/auth/service';
import { seedSecurity } from '../../database/seed-security';
import { createTestDatabase } from '../helpers/database';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof buildApp>;
let owner: string; let cashier: string; let technician: string; let supervisor: string;
const password = 'Synthetic-Master-Password-123!';
const plan = { code: 'NET999', name: 'Internet 999', serviceType: 'INTERNET', priceCentavos: 99900, installationFeeCentavos: 100000, reconnectionFeeCentavos: 10000, description: '', speedMbps: 100, channelCount: null, active: true };
const subscriber = { code: 'SUB001', name: 'Sample Subscriber', contact: '09171234567', email: 'sample@example.test', addresses: ['Malaybalay main address', 'Valencia second address'], areaId: null, collectorId: null, billingDay: 1, dueDay: 15, status: 'ACTIVE', notes: 'Private note' };
const headers = (token = owner) => ({ authorization: `Bearer ${token}` });
async function create(resource: string, data: unknown, token = owner) { return app.inject({ method: 'POST', url: `/api/v1/${resource}`, headers: headers(token), payload: { data, reason: 'Initial setup' } }); }
async function update(resource: string, row: Record<string, unknown>, data: unknown, token = owner) { return app.inject({ method: 'PUT', url: `/api/v1/${resource}/${String(row.id)}`, headers: headers(token), payload: { data, version: row.version, reason: 'Correct account details' } }); }
beforeAll(async () => {
  db = await createTestDatabase(); await seedSecurity(db.pool, { username: 'owner', displayName: 'Owner', password });
  const auth = new AuthService(db.pool); owner = (await auth.login('owner', password)).token;
  for (const [username, role] of [['cashier','CASHIER'], ['technician','TECHNICIAN'], ['supervisor','SUPERVISOR']] as const) await auth.createUser(owner, { username, displayName: username, password, roles: [role] });
  cashier = (await auth.login('cashier', password)).token; technician = (await auth.login('technician', password)).token; supervisor = (await auth.login('supervisor', password)).token;
  app = buildApp({ checkDatabase: async () => undefined, auth });
});
afterAll(async () => { await app?.close(); await db?.close(); });

it('protects master data from anonymous and read-only writes', async () => {
  expect((await app.inject('/api/v1/subscribers')).statusCode).toBe(401);
  expect((await create('plans', plan, cashier)).statusCode).toBe(403);
  expect((await app.inject({ url: '/api/v1/subscribers', headers: headers(technician) })).statusCode).toBe(403);
});
it('validates exact money, attributes and duplicate normalized codes', async () => {
  for (const priceCentavos of [1.2, -1, 1000000000]) expect((await create('plans', { ...plan, priceCentavos })).statusCode).toBe(422);
  expect((await create('plans', { ...plan, serviceType: 'CABLE', speedMbps: 100 })).statusCode).toBe(422);
  expect((await create('plans', plan)).statusCode).toBe(201);
  expect((await create('plans', { ...plan, code: ' net999 ' })).statusCode).toBe(409);
});
it('retains plan revisions and service rates when a price changes', async () => {
  const p = (await create('plans', { ...plan, code: 'HISTORY' })).json();
  const sub = (await create('subscribers', subscriber)).json();
  expect(sub.addresses).toHaveLength(2);
  const input = { code: 'SVC001', subscriberId: sub.id, planId: p.id, installationAddress: 'Malaybalay service one', activationDate: '2026-09-01', billingStartDate: '2026-09-01', billingDay: 1, dueDay: 15, currentRateCentavos: 99900, status: 'ACTIVE', areaId: null, collectorId: null, notes: '' };
  const service = await create('services', input); expect(service.statusCode).toBe(201);
  expect(recordSchema('services').safeParse(service.json())).toMatchObject({ success: true });
  expect((await create('services', { ...input, code: 'SVC002', installationAddress: 'Valencia service two' })).statusCode).toBe(201);
  const changed = await update('plans', p, { ...plan, code: 'HISTORY', priceCentavos: 109900 }); expect(changed.statusCode).toBe(200);
  const history = await app.inject({ url: `/api/v1/plans/${p.id}/history`, headers: headers() });
  expect(history.json().items.map((x: { snapshot: { priceCentavos: number } }) => x.snapshot.priceCentavos)).toEqual([109900, 99900]);
  const read = await app.inject({ url: `/api/v1/services/${service.json().id}`, headers: headers() });
  expect(read.json()).toMatchObject({ currentRateCentavos: 99900, planVersion: 1 });
  expect(read.json()).toMatchObject({ activationDate: '2026-09-01', billingStartDate: '2026-09-01' });
  expect(recordSchema('services').safeParse(read.json()).success).toBe(true);
  const edited = await update('services',read.json(),{ ...input, notes: 'Changed operational note' });
  expect(edited.statusCode).toBe(200); expect(recordSchema('services').safeParse(edited.json()).success).toBe(true);
  const assigned = await app.inject({ method: 'PATCH', url: `/api/v1/services/${service.json().id}/assignment`, headers: headers(supervisor), payload: { areaId: null,collectorId: null,version: edited.json().version,reason: 'Confirm unassigned route' } });
  expect(assigned.statusCode).toBe(200); expect(assigned.json()).toMatchObject({ planVersion: 1, activationDate: '2026-09-01' });
  const serviceHistory = await app.inject({ url: `/api/v1/services/${service.json().id}/history`, headers: headers() });
  expect(serviceHistory.json().items[0].snapshot).toMatchObject({ activationDate: '2026-09-01', billingStartDate: '2026-09-01', planVersion: 1 });

  expect((await update('subscribers', sub, { ...subscriber, status: 'ARCHIVED' })).statusCode).toBe(409);
  const search = await app.inject({ url: `/api/v1/services?subscriberId=${sub.id}`, headers: headers(cashier) }); expect(search.json().total).toBe(2);
});
it('rejects invalid dates, missing references and retains writes atomically', async () => {
  const p = (await create('plans', { ...plan, code: 'DATEPLAN' })).json();
  const sub = (await create('subscribers', { ...subscriber, code: 'SUBDATE' })).json();
  const input = { code: 'BADDATE', subscriberId: sub.id, planId: p.id, installationAddress: 'Address', activationDate: '2026-02-30', billingStartDate: '2026-09-01', billingDay: 1, dueDay: 31, currentRateCentavos: 99900, status: 'ACTIVE', areaId: null, collectorId: null, notes: '' };
  expect((await create('services', input)).statusCode).toBe(422);
  expect((await create('subscribers', { ...subscriber, code: 'MISSING', areaId: '11111111-1111-4111-8111-111111111111' })).statusCode).toBe(422);
  const found = await app.inject({ url: '/api/v1/subscribers?q=MISSING', headers: headers() }); expect(found.json().total).toBe(0);
});
it('supports area/collector assignments and prevents inactive new assignments', async () => {
  const area = (await create('areas', { code: 'AREA1', name: 'Central route', description: '', active: true }, supervisor)).json();
  const collectorInput = { code: 'COL1', name: 'Synthetic Collector', contact: '09170000000', notes: '', active: true };
  const collector = (await create('collectors', collectorInput, supervisor)).json();
  const sub = (await create('subscribers', { ...subscriber, code: 'ASSIGN' })).json();
  const assigned = await app.inject({ method: 'PATCH', url: `/api/v1/subscribers/${sub.id}/assignment`, headers: headers(supervisor), payload: { areaId: area.id, collectorId: collector.id, version: sub.version, reason: 'New route assignment' } });
  expect(assigned.statusCode).toBe(200); expect(assigned.json().collectorId).toBe(collector.id);
  expect((await update('subscribers', assigned.json(), { ...subscriber, code: 'ASSIGN' }, supervisor)).statusCode).toBe(403);
  expect((await update('collectors', collector, { ...collectorInput, active: false }, supervisor)).statusCode).toBe(200);
  expect((await create('subscribers', { ...subscriber, code: 'INACTIVE-COL', collectorId: collector.id })).statusCode).toBe(422);
});
it('rejects stale concurrent edits and records only successful history', async () => {
  const input = { code: 'CONCURRENT', name: 'Concurrent area', description: '', active: true };
  const row = (await create('areas', input)).json();
  const results = await Promise.all([update('areas', row, { ...input, name: 'First edit' }), update('areas', row, { ...input, name: 'Second edit' })]);
  expect(results.map(r => r.statusCode).sort()).toEqual([200,409]);
  const history = await app.inject({ url: `/api/v1/areas/${row.id}/history`, headers: headers() }); expect(history.json().total).toBe(2);
  expect(history.json().items[0]).toMatchObject({ reason: 'Correct account details', version: 2 });
});
it('searches names, contact and addresses with literal wildcard characters and pagination', async () => {
  expect((await create('subscribers', { ...subscriber, code: 'SEARCH', name: 'Literal 100% Match' })).statusCode).toBe(201);
  const literal = await app.inject({ url: '/api/v1/subscribers?q=%25', headers: headers(cashier) }); expect(literal.json().total).toBe(1);
  const address = await app.inject({ url: '/api/v1/subscribers?q=Valencia&perPage=1&page=1', headers: headers(cashier) }); expect(address.json().items).toHaveLength(1); expect(address.json().total).toBeGreaterThan(1);
  expect((await app.inject({ url: '/api/v1/subscribers?sort=evil', headers: headers() })).statusCode).toBe(422);
});
it('keeps technician output operational and protects identities and service types', async () => {
  const services = (await app.inject({ url: '/api/v1/services', headers: headers(technician) })).json();
  expect(services.items.length).toBeGreaterThan(0); expect(JSON.stringify(services)).not.toContain('Private note');
  const sub = (await app.inject({ url: '/api/v1/subscribers?q=SUB001', headers: headers() })).json().items[0];
  expect((await update('subscribers', sub, { ...subscriber, code: 'NEWCODE' })).statusCode).toBe(409);
  expect((await app.inject({ method: 'DELETE', url: `/api/v1/subscribers/${sub.id}`, headers: headers() })).statusCode).toBe(404);
});

it('retains inactive historical references but rejects new inactive assignments and activation', async () => {
  const areaInput = { code: 'RETAIN',name: 'Retained route',description: '',active: true };
  const area = (await create('areas',areaInput)).json();
  const subInput = { ...subscriber,code: 'RETAIN-SUB',areaId: area.id };
  const sub = (await create('subscribers',subInput)).json();
  expect((await update('areas',area,{ ...areaInput,active: false })).statusCode).toBe(200);
  const edited = await update('subscribers',sub,{ ...subInput,notes: 'Unrelated update' });
  expect(edited.statusCode).toBe(200); expect(edited.json().areaId).toBe(area.id);
  const inactive = await update('subscribers',edited.json(),{ ...subInput,status: 'INACTIVE' }); expect(inactive.statusCode).toBe(200);
  const planRow = (await create('plans',{ ...plan,code: 'INACTIVE-TEST' })).json();
  expect((await create('services',{ code: 'INACTIVE-SVC',subscriberId: sub.id,planId: planRow.id,installationAddress: 'Test installation',activationDate: '2026-09-01',billingStartDate: '2026-09-01',billingDay: 1,dueDay: 15,currentRateCentavos: 99900,status: 'ACTIVE',areaId: null,collectorId: null,notes: '' })).statusCode).toBe(422);
  expect((await app.inject({ url: `/api/v1/subscribers/${sub.id}/history`, headers: headers(technician) })).statusCode).toBe(403);
});
it('denies viewer master data and rejects extra fields in supervisor assignments', async () => {
  const auth = new AuthService(db.pool);
  await auth.createUser(owner,{ username: 'viewer',displayName: 'Viewer',password,roles: ['VIEWER'] });
  const viewer = (await auth.login('viewer',password)).token;
  for (const resource of ['plans','areas','collectors','subscribers','services']) expect((await app.inject({ url: `/api/v1/${resource}`,headers: headers(viewer) })).statusCode).toBe(403);
  const sub = (await app.inject({ url: '/api/v1/subscribers?q=SUB001',headers: headers() })).json().items[0];
  expect((await app.inject({ method: 'PATCH',url: `/api/v1/subscribers/${sub.id}/assignment`,headers: headers(supervisor),payload: { areaId: null,collectorId: null,version: sub.version,reason: 'Attempt edit',name: 'Unauthorized name' } })).statusCode).toBe(422);
});
