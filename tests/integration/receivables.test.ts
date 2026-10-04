import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../source/api/app';
import { AuthService } from '../../source/api/auth/service';
import { seedSecurity } from '../../database/seed-security';
import { createTestDatabase } from '../helpers/database';
import type { RoleCode } from '../../source/shared/auth';
import {
  ReceivableListSchema, ReceivableSummarySchema, ServicePolicySchema, SuspensionListSchema, SuspensionSchema,
  type ServiceControlEvent, type Suspension,
} from '../../source/shared/receivables';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof buildApp>;
let owner = ''; let supervisor = ''; let technician = ''; let cashier = ''; let auditor = '';
const password = 'Synthetic-Service-Control-Password-123!';
const plan = { code: 'SC999', name: 'Internet 999', serviceType: 'INTERNET', priceCentavos: 99900, installationFeeCentavos: 100000, reconnectionFeeCentavos: 10000, description: '', speedMbps: 100, channelCount: null, active: true };
const headers = (token = owner) => ({ authorization: `Bearer ${token}` });
const get = async (url: string, token = owner) => app.inject({ url: `/api/v1${url}`, headers: headers(token) });
const post = async (url: string, payload: Record<string, unknown> = {}, token = owner) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: headers(token), payload });
const put = async (url: string, payload: Record<string, unknown> = {}, token = owner) => app.inject({ method: 'PUT', url: `/api/v1${url}`, headers: headers(token), payload });
const create = (resource: string, data: unknown, token = owner) => post(`/${resource}`, { data, reason: 'Service control fixture' }, token);
const rows = async (sql: string, values: unknown[] = []) => (await db.pool.query(sql, values)).rows;

/** Creates a subscriber and an active service account for a fixture code. */
const accountFor = async (code: string) => {
  const subscriberId = (await create('subscribers', { code, name: `Sample ${code}`, contact: '09179876543', email: '', addresses: [`${code} Malaybalay`], areaId, collectorId, billingDay: 1, dueDay: 5, status: 'ACTIVE', notes: '' })).json().id;
  return (await create('services', { code: `${code}SVC`, subscriberId, planId, installationAddress: `${code} Malaybalay`, activationDate: addDays(-400), billingStartDate: addDays(-400), billingDay: 1, dueDay: 5, currentRateCentavos: 50000, status: 'ACTIVE', areaId, collectorId, notes: '' })).json().id as string;
};

/**
 * Gives an account a run of unpaid invoices. Each period is its own finalized invoice, so
 * months-unpaid, the oldest due date and the arrears total all come from real open
 * invoices rather than from a field the fixture asserts about itself.
 */
const owingAccount = async (code: string, arrearsDays: number, periods: number, amountCentavos: number) => {
  const serviceAccountId = await accountFor(code);
  for (let period = 1; period <= periods; period += 1) {
    const invoice = await post('/billing/invoices', {
      // A separate issue date per period, so each unpaid invoice lands in its own billing
      // period and the months-unpaid count is a count of months rather than of invoices.
      serviceAccountId, issueDate: addDays(-arrearsDays - 20 - (period - 1) * 30), dueDate: addDays(-arrearsDays - period),
      items: [{ itemType: 'SUBSCRIPTION', description: `Unpaid charge ${period}`, quantity: 1, unitPriceCentavos: amountCentavos / periods }],
    });
    expect(invoice.statusCode).toBe(201);
    expect((await post(`/billing/invoices/${invoice.json().id}/finalize`, { reason: 'Deliberately unpaid' })).statusCode).toBe(200);
  }
  return { serviceAccountId };
};
const attempt = async (statement: string, values: unknown[] = []) => db.pool.query(statement, values).then(() => 'allowed', (error: { message: string }) => error.message);
const summary = async (query = '', token = owner) => ReceivableSummarySchema.parse((await get(`/receivables/summary${query}`, token)).json());
const overdue = async (query = '', token = owner) => ReceivableListSchema.parse((await get(`/receivables/overdue${query}`, token)).json());
const suspensions = async (query = '', token = owner) => SuspensionListSchema.parse((await get(`/service-control/suspensions${query}`, token)).json());
// Parsed rather than cast, so a response that stops matching the shared contract fails here
// instead of silently reaching the desktop.
const suspension = async (id: string, token = owner) => SuspensionSchema.parse((await get(`/service-control/suspensions/${id}`, token)).json());
const policy = async (token = owner) => ServicePolicySchema.parse((await get('/service-control/policy', token)).json());
const history = async (serviceAccountId: string, token = owner) => (await get(`/service-control/services/${serviceAccountId}/history`, token)).json() as ServiceControlEvent[];

// Aging is measured against the server clock, so every due date is derived from it.
const clock = new Date();
const iso = (date: Date) => date.toISOString().slice(0, 10);
const today = iso(clock);
const addDays = (days: number) => iso(new Date(clock.getTime() + days * 86_400_000));

let planId = ''; let areaId = ''; let collectorId = '';
/** Accounts deliberately placed one in each aging bucket, plus one with nothing overdue. */
let byBucket = {} as Record<'D1_30' | 'D31_60' | 'D61_90' | 'D90_PLUS' | 'current', { serviceAccountId: string; code: string }>;
/**
 * Suspension and reconnection change an account, so they run against accounts of their own
 * that no aging test settles: a report test that pays an account off would otherwise decide
 * whether the disconnection tests have anything to work with.
 */
let control = {} as { serviceAccountId: string; code: string };
/** A second account for lifting, which needs its own arrears and its own policy eligibility. */
let liftOnly = { serviceAccountId: '', code: '' };
let technicianId = ''; let policyAmountCentavos = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedSecurity(db.pool, { username: 'owner', displayName: 'Owner', password });
  const auth = new AuthService(db.pool);
  owner = (await auth.login('owner', password)).token;
  app = buildApp({ checkDatabase: async () => undefined, auth, logLevel: 'silent' });
  const users: [string, RoleCode][] = [['sc-supervisor', 'SUPERVISOR'], ['sc-technician', 'TECHNICIAN'], ['sc-cashier', 'CASHIER'], ['sc-auditor', 'AUDITOR']];
  for (const [username, role] of users) {
    await auth.createUser(owner, { username, displayName: username, password, roles: [role] });
  }
  supervisor = (await auth.login('sc-supervisor', password)).token;
  technician = (await auth.login('sc-technician', password)).token;
  cashier = (await auth.login('sc-cashier', password)).token;
  auditor = (await auth.login('sc-auditor', password)).token;
  technicianId = (await rows('SELECT id FROM users WHERE username=$1', ['sc-technician']))[0].id as string;

  planId = (await create('plans', plan)).json().id;
  areaId = (await create('areas', { code: 'SCA01', name: 'Barangay 1', description: '', active: true })).json().id;
  collectorId = (await create('collectors', { code: 'SCC01', name: 'Collector 1', contact: '09181234567', notes: '', active: true })).json().id;

  // One account per bucket, each owing a different amount so the report can be checked
  // peso by peso rather than only for its total.
  const fixtures = [
    { key: 'D1_30' as const, arrearsDays: 10, amountCentavos: 11100, periods: 1 },
    { key: 'D31_60' as const, arrearsDays: 45, amountCentavos: 22200, periods: 2 },
    { key: 'D61_90' as const, arrearsDays: 75, amountCentavos: 33300, periods: 3 },
    { key: 'D90_PLUS' as const, arrearsDays: 120, amountCentavos: 44400, periods: 4 },
  ];
  byBucket = {} as typeof byBucket;
  let position = 0;
  for (const fixture of fixtures) {
    position += 1;
    const code = `SCS${position}`;
    byBucket[fixture.key] = { code, ...await owingAccount(code, fixture.arrearsDays, fixture.periods, fixture.amountCentavos) };
  }
  // An account that owes nothing must never appear as delinquent, which is the error a naive
  // report makes: an unaged account has no due date, so it must not be counted as overdue.
  const cleanCode = 'SCS9';
  byBucket.current = { code: cleanCode, serviceAccountId: await accountFor(cleanCode) };

  // Accounts for the disconnection workflows. They are kept apart from the aging fixtures
  // because these tests pay them off, change their status and lift them.
  control = { code: 'SCC1', ...await owingAccount('SCC1', 120, 4, 40000) };
  liftOnly = { code: 'SCC2', ...await owingAccount('SCC2', 150, 1, 90000) };

  // A policy that makes the control account eligible and the milder aging accounts not, so
  // both the grace period and the threshold are actually exercised.
  policyAmountCentavos = 30000;
  const saved = await put('/service-control/policy', { gracePeriodDays: 90, suspensionThresholdCentavos: policyAmountCentavos, autoSuspend: false, reconnectionFeeCentavos: 75000, reason: 'Initial laboratory policy' });
  expect(saved.statusCode).toBe(200);
});

afterAll(async () => {
  await app?.close();
  await db?.close();
});

/** The one account that meets the policy: 90+ days overdue and above the threshold. */
const eligible = () => control.serviceAccountId;
/** Every peso the fixtures deliberately left unpaid, so a total is never a magic number. */
const fixtureArrears = { D1_30: 11100, D31_60: 22200, D61_90: 33300, D90_PLUS: 44400, control: 40000, liftOnly: 90000 };
/**
 * Pays an account in full. A cash payment is allocated to the oldest invoices on the spot,
 * so settling means paying the exact open balance rather than moving money around.
 */
const settle = async (serviceAccountId: string) => {
  const subscriberId = (await rows('SELECT subscriber_id FROM service_accounts WHERE id=$1', [serviceAccountId]))[0].subscriber_id as string;
  const open = await rows(`SELECT coalesce(sum(balance_centavos),0)::int AS total FROM invoices
    WHERE service_account_id=$1 AND status IN ('UNPAID','PARTIALLY_PAID','OVERDUE') AND balance_centavos>0`, [serviceAccountId]);
  const total = open[0].total as number;
  if (total === 0) return;
  const payment = await post('/payments', { subscriberId, method: 'CASH', amountCentavos: total, receivedOn: today });
  expect(payment.statusCode).toBe(201);
  // The payment has to have landed on the invoices themselves, not merely been recorded.
  const still = await rows(`SELECT coalesce(sum(balance_centavos),0)::int AS total FROM invoices
    WHERE service_account_id=$1 AND status IN ('UNPAID','PARTIALLY_PAID','OVERDUE') AND balance_centavos>0`, [serviceAccountId]);
  expect(still[0].total).toBe(0);
};

describe('receivables permissions', () => {
  it('refuses anonymous requests and roles that may not read the money', async () => {
    expect((await app.inject('/api/v1/receivables/summary')).statusCode).toBe(401);
    expect((await app.inject('/api/v1/receivables/overdue')).statusCode).toBe(401);
    expect((await get('/receivables/summary', auditor)).statusCode).toBe(200);
    expect((await get('/receivables/overdue', supervisor)).statusCode).toBe(200);
    // A cashier takes money but does not administer receivables, and a technician works on
    // service accounts rather than reading what is owed.
    expect((await get('/receivables/summary', cashier)).statusCode).toBe(403);
    expect((await get('/receivables/overdue', technician)).statusCode).toBe(403);
    // Service control is the office's decision, not the auditor's or the cashier's.
    expect((await get('/service-control/suspensions', auditor)).statusCode).toBe(403);
    expect((await get('/service-control/suspensions', cashier)).statusCode).toBe(403);
    expect((await get('/service-control/suspensions', supervisor)).statusCode).toBe(200);
    expect((await get('/service-control/policy', technician)).statusCode).toBe(403);
  });
});

describe('the aging report', () => {
  it('places every account in the bucket its oldest unpaid due date earns', async () => {
    for (const bucket of ['D1_30', 'D31_60', 'D61_90', 'D90_PLUS'] as const) {
      const row = (await overdue(`?perPage=100`)).items.find((item) => item.serviceAccountId === byBucket[bucket].serviceAccountId)!;
      expect(row, `${bucket} account must be listed`).toBeTruthy();
      expect(row.bucket).toBe(bucket);
    }
    // The account with nothing overdue is never counted as delinquent.
    expect((await overdue('?perPage=100')).items.some((item) => item.serviceAccountId === byBucket.current.serviceAccountId)).toBe(false);
  });

  it('adds back to the total receivable, peso for peso', async () => {
    const value = await summary();
    expect(value.aging).toHaveLength(5);
    expect(value.aging.reduce((total, bucket) => total + bucket.totalCentavos, 0)).toBe(value.totalReceivableCentavos);
    expect(value.totalReceivableCentavos).toBe(value.currentReceivableCentavos + value.overdueReceivableCentavos);
    // Every peso the fixtures left unpaid, counted from the fixture amounts rather than
    // from a number typed twice, so a change to a fixture cannot hide behind a stale total.
    const total = Object.values(fixtureArrears).reduce((sum, amount) => sum + amount, 0);
    expect(value.overdueReceivableCentavos).toBe(total);
    expect(value.overdueReceivableCentavos).toBeGreaterThan(value.currentReceivableCentavos);
    expect(value.dataAsOf).toBe(today);
    // The aging buckets are a split of the same invoices, so each bucket is the accounts in
    // it and nothing else.
    const listed = (await overdue('?perPage=100')).items;
    for (const bucket of ['D1_30', 'D31_60', 'D61_90', 'D90_PLUS'] as const) {
      const inBucket = listed.filter((row) => row.bucket === bucket);
      expect(value.aging.find((entry) => entry.bucket === bucket)!.totalCentavos).toBe(inBucket.reduce((sum, row) => sum + row.arrearsCentavos, 0));
    }
  });

  it('reports each account only under the collector and area it belongs to', async () => {
    const otherAreaId = (await create('areas', { code: 'SCA02', name: 'Barangay 2', description: '', active: true })).json().id;
    const byArea = await overdue(`?areaId=${otherAreaId}&perPage=100`);
    expect(byArea.total).toBe(0);
    const byCollector = await overdue(`?collectorId=${collectorId}&perPage=100`);
    // Every fixture account shares this collector, and the one account that owes nothing is
    // not on the list, so the count is the number of owing fixtures and nothing else.
    expect(byCollector.total).toBe(Object.keys(fixtureArrears).length);
    // A bucket filter is the aging report's own axis, so it must agree with the buckets.
    expect((await overdue('?bucket=D90_PLUS&perPage=100')).items.every((row) => row.bucket === 'D90_PLUS')).toBe(true);
    expect((await overdue('?minOverdueDays=100&perPage=100')).items.every((row) => row.overdueDays >= 100)).toBe(true);
  });

  it('falls to zero the moment the last peso is paid, without anything being recalculated', async () => {
    const before = (await overdue('?perPage=100')).items.find((row) => row.serviceAccountId === byBucket.D90_PLUS.serviceAccountId)!;
    expect(before.arrearsCentavos).toBe(fixtureArrears.D90_PLUS);
    await settle(byBucket.D90_PLUS.serviceAccountId);
    const after = (await overdue('?perPage=100')).items.find((row) => row.serviceAccountId === byBucket.D90_PLUS.serviceAccountId);
    expect(after).toBeUndefined();
    const value = await summary();
    const stillOwed = Object.entries(fixtureArrears).filter(([key]) => key !== 'D90_PLUS').reduce((sum, [, amount]) => sum + amount, 0);
    expect(value.overdueReceivableCentavos).toBe(stillOwed);
    // The bucket holds the accounts still in it, so paying one off lowers it by exactly that
    // account's arrears rather than emptying a bucket other accounts are still in.
    const ninetyPlus = value.aging.find((bucket) => bucket.bucket === 'D90_PLUS')!;
    expect(ninetyPlus.totalCentavos).toBe(fixtureArrears.control + fixtureArrears.liftOnly);
    expect(ninetyPlus.totalCentavos).toBeLessThan(before.arrearsCentavos + ninetyPlus.totalCentavos);
    // Once it owes nothing at all the account leaves the worklist, so it is worth checking on
    // an account that still owes something: a partial payment moves its arrears down and shows
    // up as the last payment, with nothing recalculated onto a stored figure.
    const partial = 2000;
    const partialPayment = await post('/payments', { subscriberId: (await rows('SELECT subscriber_id FROM service_accounts WHERE id=$1', [byBucket.D31_60.serviceAccountId]))[0].subscriber_id as string, method: 'CASH', amountCentavos: partial, receivedOn: today });
    expect(partialPayment.statusCode).toBe(201);
    const listed = (await overdue('?perPage=100')).items.find((row) => row.serviceAccountId === byBucket.D31_60.serviceAccountId)!;
    expect(listed.arrearsCentavos).toBe(fixtureArrears.D31_60 - partial);
    expect(listed.lastPaymentDate).toBe(today);
    expect(listed.lastPaymentAmountCentavos).toBe(partial);
    expect((await summary()).overdueReceivableCentavos).toBe(stillOwed - partial);
    // The paid account is simply not on the list any more, settled or not.
    expect((await overdue('?includeCurrent=true&perPage=100')).items.some((row) => row.serviceAccountId === byBucket.D90_PLUS.serviceAccountId)).toBe(false);
  });
});

describe('the service policy', () => {
  it('keeps who decided the rule and why', async () => {
    const value = await policy();
    expect(value.gracePeriodDays).toBe(90);
    expect(value.suspensionThresholdCentavos).toBe(policyAmountCentavos);
    expect(value.reconnectionFeeCentavos).toBe(75000);
    expect(value.updatedName).toBeTruthy();
    // The rule is appended, so the previous decision is still on record.
    const changes = await rows('SELECT details FROM audit_logs WHERE action=$1 ORDER BY created_at', ['service.policy.update']);
    expect(changes.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses a policy that would suspend everybody immediately', async () => {
    expect((await put('/service-control/policy', { gracePeriodDays: -1, suspensionThresholdCentavos: 0, autoSuspend: false, reconnectionFeeCentavos: 0, reason: 'Nonsense' })).statusCode).toBe(422);
    expect((await put('/service-control/policy', { gracePeriodDays: 0, suspensionThresholdCentavos: -100, autoSuspend: false, reconnectionFeeCentavos: 0, reason: 'Nonsense' })).statusCode).toBe(422);
    expect((await put('/service-control/policy', { gracePeriodDays: 0, suspensionThresholdCentavos: 0, autoSuspend: false, reconnectionFeeCentavos: 0 })).statusCode).toBe(422);
  });
});

describe('suspending a service', () => {
  it('refuses an account that does not meet the policy, and says why', async () => {
    // Below the threshold.
    expect((await post(`/service-control/services/${byBucket.D61_90.serviceAccountId}/suspend`, { reason: 'Too small to cut off' })).statusCode).toBe(409);
    // Inside the grace period.
    expect((await post(`/service-control/services/${byBucket.D31_60.serviceAccountId}/suspend`, { reason: 'Still in grace' })).statusCode).toBe(409);
    // Nothing overdue at all.
    expect((await post(`/service-control/services/${byBucket.current.serviceAccountId}/suspend`, { reason: 'Nothing owed' })).statusCode).toBe(409);
    expect((await post('/service-control/services/11111111-1111-4111-8111-111111111111/suspend', { reason: 'No such service' })).statusCode).toBe(404);
    expect((await post(`/service-control/services/${eligible()}/suspend`, { reason: '' })).statusCode).toBe(422);
    // None of the refusals left a document behind.
    expect((await suspensions()).total).toBe(0);
  });

  it('freezes the receivable onto the document and suspends the account', async () => {
    const response = await post(`/service-control/services/${eligible()}/suspend`, { reason: 'Four months unpaid', notes: 'Two follow-up visits made', effectiveDate: addDays(-2) });
    expect(response.statusCode).toBe(200);
    const value = response.json() as Suspension;
    expect(value.suspensionNumber).toMatch(/^SUS-\d{4}-\d{4}$/);
    expect(value.status).toBe('ACTIVE');
    expect(value.reason).toBe('Four months unpaid');
    expect(value.notes).toBe('Two follow-up visits made');
    expect(value.approvedName).toBeTruthy();
    // The document carries what was true on its effective date, not what is true now.
    expect(value.arrearsAtSuspensionCentavos).toBe(fixtureArrears.control);
    expect(value.monthsUnpaidAtSuspension).toBe(4);
    expect(value.gracePeriodDays).toBe(90);
    expect(value.thresholdCentavos).toBe(policyAmountCentavos);
    expect(value.effectiveDate).toBe(addDays(-2));
    expect(value.liftedAt).toBeNull();
    expect((await rows('SELECT status FROM service_accounts WHERE id=$1', [eligible()]))[0].status).toBe('SUSPENDED');
    // The list finds it without a filter.
    expect((await suspensions()).total).toBe(1);
  });

  it('records the disconnection in the service history', async () => {
    const events = await history(eligible());
    const suspended = events.find((event) => event.eventType === 'SUSPENDED')!;
    expect(suspended.reason).toBe('Four months unpaid');
    expect(suspended.amountCentavos).toBe(fixtureArrears.control);
    expect(suspended.effectiveDate).toBe(addDays(-2));
    expect(suspended.actorName).toBeTruthy();
    expect(suspended.summary).toContain('Four months unpaid');
  });

  it('refuses a second suspension while the first is still in force', async () => {
    expect((await post(`/service-control/services/${eligible()}/suspend`, { reason: 'Still disconnected' })).statusCode).toBe(409);
    expect((await suspensions()).total).toBe(1);
  });
});

describe('the database refuses an unmanaged disconnection', () => {
  it('will not suspend, lift, edit or delete a suspension through raw SQL', async () => {
    const id = (await rows('SELECT id FROM suspensions LIMIT 1'))[0].id as string;
    // An account that is still active, because a row that is already suspended has no status
    // change for the guard to refuse.
    expect(await attempt(`UPDATE service_accounts SET status='SUSPENDED' WHERE id=$1`, [liftOnly.serviceAccountId])).toContain('bcis_control_required');
    expect(await attempt(`UPDATE service_accounts SET status='ACTIVE' WHERE id=$1`, [eligible()])).toContain('bcis_control_required');
    expect(await attempt(`UPDATE suspensions SET status='LIFTED',lifted_at=now() WHERE id=$1`, [id])).toContain('bcis_immutable_row');
    expect(await attempt(`UPDATE suspensions SET arrears_at_suspension_centavos=0 WHERE id=$1`, [id])).toContain('bcis_immutable_row');
    expect(await attempt(`UPDATE suspensions SET reason='Rewritten' WHERE id=$1`, [id])).toContain('bcis_immutable_row');
    expect(await attempt('DELETE FROM suspensions WHERE id=$1', [id])).toContain('bcis_immutable_row');
    // Even a managed transaction cannot rewrite the document or skip the lifecycle.
    const managed = async (statement: string, values: unknown[] = []) => {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL bcis.control='on'");
        await client.query(statement, values);
        await client.query('ROLLBACK');
        return 'allowed';
      } catch (error) { await client.query('ROLLBACK'); return (error as { message: string }).message; }
      finally { client.release(); }
    };
    expect(await managed('UPDATE suspensions SET arrears_at_suspension_centavos=0 WHERE id=$1', [id])).toContain('bcis_immutable_row');
    expect(await managed('UPDATE suspensions SET status=\'LIFTED\' WHERE id=$1', [id])).toContain('bcis_incomplete_transition');
  });

  it('will not commit a status change that left no history entry', async () => {
    // A managed transaction may move the account, but the deferred check then asks who
    // recorded it, so a change without a history row cannot be committed.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL bcis.control='on'");
      await client.query('UPDATE service_accounts SET status=$2 WHERE id=$1', [eligible(), 'ACTIVE']);
      await client.query('COMMIT');
      expect.unreachable('the commit should have been refused for want of a history entry');
    } catch (error) {
      expect((error as { message: string }).message).toContain('bcis_history_required');
    } finally { client.release(); }
    expect((await rows('SELECT status FROM service_accounts WHERE id=$1', [eligible()]))[0].status).toBe('SUSPENDED');
  });
});

describe('reconnecting a service', () => {
  it('refuses a reconnection while the account still owes money', async () => {
    const id = (await rows('SELECT id FROM suspensions LIMIT 1'))[0].id as string;
    const response = await post(`/service-control/suspensions/${id}/reconnection`, {});
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('still has an outstanding balance');
    expect(await rows('SELECT count(*)::int AS total FROM reconnections')).toEqual([{ total: 0 }]);
  });

  it('raises the request with the policy fee once the account is settled', async () => {
    await settle(eligible());
    const id = (await rows('SELECT id FROM suspensions LIMIT 1'))[0].id as string;
    const response = await post(`/service-control/suspensions/${id}/reconnection`, { notes: 'Customer paid in full' });
    expect(response.statusCode).toBe(200);
    const value = response.json() as Suspension;
    expect(value.reconnectionNumber).toMatch(/^RCO-\d{4}-\d{4}$/);
    expect(value.reconnectionStatus).toBe('REQUESTED');
    // The fee came from the policy, so the clerk did not have to know it.
    expect(value.reconnectionFeeCentavos).toBe(75000);
    expect(value.reconnectionRequestDate).toBe(today);
    expect(value.reconnectionCompletedDate).toBeNull();
    expect(value.technicianName).toBeNull();
    // The account is still disconnected: raising a request does not restore service.
    expect((await rows('SELECT status FROM service_accounts WHERE id=$1', [eligible()]))[0].status).toBe('SUSPENDED');
    expect(value.status).toBe('ACTIVE');
  });

  it('refuses to assign a technician who is not one', async () => {
    const id = (await rows('SELECT id FROM suspensions LIMIT 1'))[0].id as string;
    const cashierId = (await rows('SELECT id FROM users WHERE username=$1', ['sc-cashier']))[0].id as string;
    const response = await post(`/service-control/suspensions/${id}/reconnection/assign`, { technicianId: cashierId, notes: 'Cashier cannot do this' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields).toHaveProperty('technicianId');
    expect((await suspension(id)).reconnectionStatus).toBe('REQUESTED');
  });

  it('refuses to complete a reconnection nobody has been assigned to', async () => {
    const id = (await rows('SELECT id FROM suspensions LIMIT 1'))[0].id as string;
    expect((await post(`/service-control/suspensions/${id}/reconnection/complete`, { notes: 'Done' })).statusCode).toBe(409);
  });

  it('assigns the technician and then restores the service, keeping both documents', async () => {
    const id = (await rows('SELECT id FROM suspensions LIMIT 1'))[0].id as string;
    const technicians = (await get('/service-control/technicians')).json() as { id: string; displayName: string }[];
    expect(technicians.map((user) => user.displayName)).toContain('sc-technician');
    expect((await post(`/service-control/suspensions/${id}/reconnection/assign`, { technicianId: technicianId, notes: 'Scheduled for Friday' })).statusCode).toBe(200);
    const assigned = await suspension(id);
    expect(assigned.reconnectionStatus).toBe('ASSIGNED');
    expect(assigned.technicianId).toBe(technicianId);
    expect(assigned.technicianName).toBe('sc-technician');
    // The service stays off until the work is actually reported done.
    expect((await rows('SELECT status FROM service_accounts WHERE id=$1', [eligible()]))[0].status).toBe('SUSPENDED');

    const completed = await post(`/service-control/suspensions/${id}/reconnection/complete`, { completedOn: addDays(-1), notes: 'Line re-spliced' });
    expect(completed.statusCode).toBe(200);
    const value = completed.json() as Suspension;
    expect(value.reconnectionStatus).toBe('COMPLETED');
    expect(value.reconnectionCompletedDate).toBe(addDays(-1));
    // Completing the reconnection lifts the suspension it answered, so the disconnection and
    // its resolution are both still on record.
    expect(value.status).toBe('LIFTED');
    // A date, not a timestamp: the contract reports the day the document ended.
    expect(value.liftedAt).toBe(today);
    expect(value.liftedByName).toBeTruthy();
    expect((await rows('SELECT status FROM service_accounts WHERE id=$1', [eligible()]))[0].status).toBe('ACTIVE');
  });

  it('cannot be completed twice, and its document is not editable', async () => {
    const id = (await rows('SELECT id FROM suspensions LIMIT 1'))[0].id as string;
    expect((await post(`/service-control/suspensions/${id}/reconnection/complete`, { notes: 'Again' })).statusCode).toBe(409);
    expect((await post(`/service-control/suspensions/${id}/reconnection/assign`, { technicianId, notes: 'Reassigned' })).statusCode).toBe(409);
    const reconnectionId = (await rows('SELECT id FROM reconnections LIMIT 1'))[0].id as string;
    expect(await attempt('UPDATE reconnections SET fee_centavos=0 WHERE id=$1', [reconnectionId])).toContain('bcis_immutable_row');
    expect(await attempt('DELETE FROM reconnections WHERE id=$1', [reconnectionId])).toContain('bcis_immutable_row');
  });

  it('keeps the whole disconnection on the service history', async () => {
    const types = (await history(eligible())).map((event) => event.eventType);
    expect(types).toContain('SUSPENDED');
    expect(types).toContain('RECONNECTION_REQUESTED');
    expect(types).toContain('RECONNECTION_ASSIGNED');
    expect(types).toContain('RECONNECTION_COMPLETED');
  });
});

describe('lifting a disconnection', () => {
  it('needs a reason, and never forgets the document', async () => {
    // A fresh suspension, so lifting is exercised on its own rather than through a reconnect.
    const code = 'SCS8';
    const subscriberId = (await create('subscribers', { code, name: 'Sample 8', contact: '09179876543', email: '', addresses: [`${code} Malaybalay`], areaId, collectorId, billingDay: 1, dueDay: 5, status: 'ACTIVE', notes: '' })).json().id;
    const serviceAccountId = (await create('services', { code: `${code}SVC`, subscriberId, planId, installationAddress: `${code} Malaybalay`, activationDate: addDays(-300), billingStartDate: addDays(-300), billingDay: 1, dueDay: 5, currentRateCentavos: 50000, status: 'ACTIVE', areaId, collectorId, notes: '' })).json().id;
    const invoice = await post('/billing/invoices', { serviceAccountId, issueDate: addDays(-200), dueDate: addDays(-150), items: [{ itemType: 'SUBSCRIPTION', description: 'Long unpaid', quantity: 1, unitPriceCentavos: 90000 }] });
    expect((await post(`/billing/invoices/${invoice.json().id}/finalize`, { reason: 'Deliberately unpaid' })).statusCode).toBe(200);
    const raised = await post(`/service-control/services/${serviceAccountId}/suspend`, { reason: 'Long disconnection' });
    expect(raised.statusCode).toBe(200);
    const id = (raised.json() as Suspension).id;
    expect((await post(`/service-control/suspensions/${id}/lift`, {})).statusCode).toBe(422);
    const lifted = await post(`/service-control/suspensions/${id}/lift`, { reason: 'Paid at the counter' });
    expect(lifted.statusCode).toBe(200);
    const value = lifted.json() as Suspension;
    expect(value.status).toBe('LIFTED');
    expect(value.liftedByName).toBeTruthy();
    expect((await rows('SELECT status FROM service_accounts WHERE id=$1', [serviceAccountId]))[0].status).toBe('ACTIVE');
    // The arrears that caused it are untouched: lifting a disconnection does not forgive a debt.
    const row = (await overdue('?perPage=100')).items.find((item) => item.serviceAccountId === serviceAccountId)!;
    expect(row.arrearsCentavos).toBe(90000);
    expect((await history(serviceAccountId)).some((event) => event.eventType === 'LIFTED')).toBe(true);
  });
});
