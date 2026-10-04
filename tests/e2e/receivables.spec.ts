import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { createTestDatabase } from '../helpers/database';
import { seedSecurity } from '../../database/seed-security';
import { AuthService } from '../../source/api/auth/service';
import { buildApp } from '../../source/api/app';

let db: Awaited<ReturnType<typeof createTestDatabase>>; let api: ReturnType<typeof buildApp>; let origin: string; let token = '';
const password = 'Synthetic-Phase7-Password-123!';
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;

const clock = new Date();
const iso = (date: Date) => date.toISOString().slice(0, 10);
const today = iso(clock);
const addDays = (days: number) => iso(new Date(clock.getTime() + days * 86_400_000));

let planId = ''; let areaId = ''; let collectorId = ''; let eligibleServiceId = ''; let graceServiceId = ''; let settledSubscriberId = '';

test.beforeAll(async () => {
  db = await createTestDatabase();
  await seedSecurity(db.pool, { username: 'owner', displayName: 'Owner', password });
  const auth = new AuthService(db.pool);
  token = (await auth.login('owner', password)).token;
  // A technician is needed to assign a reconnection visit to, and an auditor to prove the screen
  // is read-only for anyone who may not change a service status.
  await auth.createUser(token, { username: 'technician', displayName: 'Tech Ramon', password, roles: ['TECHNICIAN'] });
  await auth.createUser(token, { username: 'auditor', displayName: 'Auditor', password, roles: ['AUDITOR'] });
  api = buildApp({ checkDatabase: async () => undefined, auth, logLevel: 'silent' });
  origin = await api.listen({ host: '127.0.0.1', port: 0 });

  const send = (path: string, method: string, body: unknown) => fetch(`${origin}/api/v1${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const create = async (resource: string, data: unknown) => {
    const response = await send(`/${resource}`, 'POST', { data, reason: 'Phase 7 fixture' });
    if (!response.ok) throw new Error(`${resource} fixture failed: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ id: string }>;
  };
  const invoice = async (serviceAccountId: string, dueDate: string, issueDate: string, unitPriceCentavos: number) => {
    const response = await send('/billing/invoices', 'POST', { serviceAccountId, issueDate, dueDate, items: [{ itemType: 'SUBSCRIPTION', description: `Unpaid ${dueDate}`, quantity: 1, unitPriceCentavos }] });
    if (!response.ok) throw new Error(`invoice fixture failed: ${response.status} ${await response.text()}`);
    const created = await response.json() as { id: string };
    await send(`/billing/invoices/${created.id}/finalize`, 'POST', { reason: 'Deliberately unpaid' });
  };

  const plan = await create('plans', { code: 'PHA700', name: 'Phase 7 internet', serviceType: 'INTERNET', priceCentavos: 50000, installationFeeCentavos: 100000, reconnectionFeeCentavos: 10000, description: '', speedMbps: 100, channelCount: null, active: true });
  planId = plan.id;
  areaId = (await create('areas', { code: 'PHA70', name: 'Poblacion North', description: '', active: true })).id;
  collectorId = (await create('collectors', { code: 'PHA70C', name: 'Ana Collector', contact: '09181234567', notes: '', active: true })).id;

  const account = async (code: string, name: string) => {
    const subscriber = await create('subscribers', { code, name, contact: '09179876543', email: '', addresses: [`${code} Malaybalay`], areaId, collectorId, billingDay: 1, dueDay: 5, status: 'ACTIVE', notes: '' });
    const service = await create('services', { code: `${code}SVC`, subscriberId: subscriber.id, planId, installationAddress: `${code} Malaybalay`, activationDate: '2025-01-01', billingStartDate: '2025-01-01', billingDay: 1, dueDay: 5, currentRateCentavos: 50000, status: 'ACTIVE', areaId, collectorId, notes: '' });
    return { subscriberId: subscriber.id, serviceAccountId: service.id };
  };

  // Four separate months, so the months-unpaid count on the document is a count of months.
  const overdue = async (code: string, name: string, daysLate: number, periods: number, amountCentavos: number) => {
    const created = await account(code, name);
    for (let period = 1; period <= periods; period += 1) await invoice(created.serviceAccountId, addDays(-daysLate - period), addDays(-daysLate - 20 - (period - 1) * 30), amountCentavos / periods);
    return created;
  };
  const eligible = await overdue('PHA7ELIG', 'Eligible Sample', 120, 4, 40000);
  eligibleServiceId = eligible.serviceAccountId;
  await overdue('PHA7GRACE', 'Grace Sample', 40, 1, 50000);
  graceServiceId = (await db.pool.query('SELECT id FROM service_accounts WHERE code=$1', ['PHA7GRACESVC'])).rows[0].id as string;
  const toSettle = await overdue('PHA7SETTLE', 'Settled Sample', 120, 4, 30000);
  settledSubscriberId = toSettle.subscriberId;

  // The office policy is set explicitly, so the screen is not asserting a default nobody chose.
  await send('/service-control/policy', 'PUT', { gracePeriodDays: 90, suspensionThresholdCentavos: 30000, autoSuspend: false, reconnectionFeeCentavos: 75000, reason: 'Phase 7 fixture policy' });
  // The account that will be settled is paid before the test starts, so a reconnection is legal.
  const payment = await send('/payments', 'POST', { subscriberId: settledSubscriberId, method: 'CASH', amountCentavos: 30000, receivedOn: today });
  if (!payment.ok) throw new Error(`payment fixture failed: ${payment.status} ${await payment.text()}`);
});
test.afterAll(async () => { await api?.close(); await db?.close(); });

async function signIn(page: Page, username: string) {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your BCIS workspace' })).toBeVisible();
}
const confirmation = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });

/** The customer pays what is outstanding, recorded through the API so the test is about screens. */
async function settleOutstanding() {
  const open = (await db.pool.query(
    `SELECT coalesce(sum(i.balance_centavos),0)::int AS total FROM invoices i
     WHERE i.service_account_id=$1 AND i.status IN ('UNPAID','PARTIALLY_PAID','OVERDUE') AND i.balance_centavos>0`,
    [eligibleServiceId],
  )).rows[0].total as number;
  if (open === 0) return;
  const subscriber = (await db.pool.query('SELECT subscriber_id FROM service_accounts WHERE id=$1', [eligibleServiceId])).rows[0].subscriber_id as string;
  const response = await fetch(`${origin}/api/v1/payments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ subscriberId: subscriber, method: 'CASH', amountCentavos: open, receivedOn: today }),
  });
  if (!response.ok) throw new Error(`settlement failed: ${response.status} ${await response.text()}`);
}

test('an account past the policy is disconnected with a reason, paid off, reconnected and the whole trail stays on the register', async () => {
  test.setTimeout(240_000);
  const desktop = await electron.launch({ args: ['.'], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow(); await signIn(page, 'owner');
    await page.getByRole('button', { name: 'Receivables', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Aging report' })).toBeVisible();

    // FND-07 applies to this screen too: the totals and the table must fit a narrow window.
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 700));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(900);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1400, 900));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThan(900);

    // The aging buckets are shown as figures the server derived, split by how late each is.
    const strip = page.locator('.aging-strip');
    await expect(strip).toContainText('90+ days');
    await expect(strip).toContainText('31 to 60 days');
    await expect(page.locator('.stat-row')).toContainText('Total receivable');
    await page.screenshot({ path: 'docs/screenshots/receivables-aging.png', fullPage: true });

    // An account inside the grace period is never offered a disconnection, because the API
    // would refuse it. The screen hides the command rather than letting the user fail.
    const graceRow = page.getByRole('row', { name: /PHA7GRACE/ });
    await expect(graceRow).toBeVisible();
    await expect(graceRow.getByRole('button', { name: /^Suspend / })).toHaveCount(0);

    // The account past the policy is disconnected, and the reason is compulsory.
    const eligibleRow = page.getByRole('row', { name: /PHA7ELIG/ });
    await expect(eligibleRow).toBeVisible();
    await eligibleRow.getByRole('button', { name: /^Suspend PHA7ELIG$/ }).click();
    await expect(page.getByRole('button', { name: 'Confirm disconnection', exact: true })).toBeDisabled();
    await page.getByLabel('Suspension reason').fill('Four months unpaid after two visits');
    await page.getByRole('button', { name: 'Confirm disconnection', exact: true }).click();
    await expect(confirmation(page, 'was disconnected')).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/receivables-suspended.png', fullPage: true });

    // The register holds the document, with the receivable frozen onto it at the moment of the
    // decision rather than whatever the balance has become since.
    await page.getByRole('tab', { name: 'Suspensions & reconnections' }).click();
    await expect(page.getByRole('heading', { name: 'Suspensions & reconnections' })).toBeVisible();
    const registerRow = page.getByRole('row', { name: /PHA7ELIG/ });
    await expect(registerRow).toContainText('Four months unpaid after two visits');
    await expect(registerRow).toContainText('PHP 400.00');
    const suspensionNumber = (await registerRow.locator('strong').first().innerText()).trim();

    // The service history is the append-only record, so it shows who did it and why.
    await registerRow.getByRole('button', { name: `Open ${suspensionNumber}` }).click();
    await expect(page.getByText('Service history')).toBeVisible();
    await expect(page.locator('.history-list')).toContainText('Four months unpaid after two visits');

    // Reconnection is refused while the balance is still open, so the account has to be paid
    // off first. The refusal is the server's, not a rule the screen invented.
    await page.getByRole('button', { name: 'Request reconnection', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('outstanding balance');
    await page.getByLabel('Reconnection notes').fill('Balance settled in cash');
    await settleOutstanding();

    // The fee comes from the policy, so the clerk does not have to know the tariff.
    await page.getByRole('button', { name: 'Request reconnection', exact: true }).click();
    await expect(confirmation(page, 'PHP 750.00')).toBeVisible();

    // The technician comes from the API, so the list cannot offer an inactive or invented name.
    await page.getByLabel('Choose technician').selectOption({ label: 'Tech Ramon' });
    await page.getByRole('button', { name: 'Assign technician', exact: true }).click();
    await expect(confirmation(page, 'was assigned')).toBeVisible();
    await page.getByRole('button', { name: 'Complete reconnection', exact: true }).click();
    await expect(confirmation(page, 'was completed')).toBeVisible();

    // Both documents are still there afterwards, and the service is active again. Completing the
    // reconnection is what lifts the suspension, so a disconnection is never resolved silently.
    const restored = (await db.pool.query('SELECT status FROM service_accounts WHERE id=$1', [eligibleServiceId])).rows[0].status;
    expect(restored).toBe('ACTIVE');
    await expect(page.getByRole('row', { name: new RegExp(suspensionNumber) })).toContainText('COMPLETED');
    await expect(page.getByRole('row', { name: new RegExp(suspensionNumber) })).toContainText('LIFTED');
    // The history carries the whole trail, including the reconnection that resolved it.
    await expect(page.locator('.history-list')).toContainText('reconnection completed');
    await page.screenshot({ path: 'docs/screenshots/receivables-reconnected.png', fullPage: true });

    // The account owes nothing now, so a fresh disconnection is refused by the policy check: a
    // restored service is not something the office may cut off again without a reason to.
    const secondAttempt = await fetch(`${origin}/api/v1/service-control/services/${eligibleServiceId}/suspend`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ reason: 'Second attempt' }),
    });
    expect(secondAttempt.status).toBe(409);
    // An account inside the grace period cannot be cut off at all, so the decision is refused
    // before any document is written and the service is left alone.
    const insideGrace = await fetch(`${origin}/api/v1/service-control/services/${graceServiceId}/suspend`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ reason: 'Inside the grace period' }),
    });
    expect(insideGrace.status).toBe(409);
    const graceStatus = (await db.pool.query('SELECT status FROM service_accounts WHERE id=$1', [graceServiceId])).rows[0].status;
    expect(graceStatus).toBe('ACTIVE');
    const documents = await db.pool.query('SELECT count(*)::int AS total FROM suspensions');
    // Only the one disconnection from this run was ever filed.
    expect(documents.rows[0].total).toBe(1);
  } finally { await desktop.close(); }
});

test('an auditor may read the aging report but is never offered a service control screen', async () => {
  test.setTimeout(120_000);
  const desktop = await electron.launch({ args: ['.'], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow();
    await signIn(page, 'auditor');
    // Navigation follows the permissions the API returned.
    await page.getByRole('button', { name: 'Receivables', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Aging report' })).toBeVisible();
    await expect(page.locator('.stat-row')).toContainText('Total receivable');
    await expect(page.getByRole('row', { name: /PHA7ELIG/ }).getByRole('button', { name: /^Suspend / })).toHaveCount(0);

    // The register and the policy are not offered at all, because the auditor may read the money
    // but never change a service status. Hiding the tab is better than showing a screen whose
    // every command the API would refuse.
    await expect(page.getByRole('tab', { name: 'Aging report' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Suspensions & reconnections' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Service policy' })).toHaveCount(0);
  } finally { await desktop.close(); }
});
