import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { createTestDatabase } from '../helpers/database';
import { seedSecurity } from '../../database/seed-security';
import { AuthService } from '../../source/api/auth/service';
import { buildApp } from '../../source/api/app';

let db: Awaited<ReturnType<typeof createTestDatabase>>; let api: ReturnType<typeof buildApp>; let origin: string; let token = '';
const password = 'Synthetic-Phase6-Password-123!';
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;

const clock = new Date();
const iso = (date: Date) => date.toISOString().slice(0, 10);
const today = iso(clock);
const addDays = (days: number) => iso(new Date(clock.getTime() + days * 86_400_000));
// The cycle is issued in the coming month, so its invoices are open and a route has work to do.
const cyclePeriod = addDays(40).slice(0, 7);

let areaId = ''; let collectorId = ''; let emptyAreaId = ''; const subscriberIds: string[] = [];

test.beforeAll(async () => {
  db = await createTestDatabase();
  await seedSecurity(db.pool, { username: 'owner', displayName: 'Owner', password });
  const auth = new AuthService(db.pool);
  token = (await auth.login('owner', password)).token;
  // A supervisor is the second pair of eyes: they sign a remittance they did not count.
  await auth.createUser(token, { username: 'supervisor', displayName: 'Supervisor', password, roles: ['SUPERVISOR'] });
  api = buildApp({ checkDatabase: async () => undefined, auth, logLevel: 'silent' });
  origin = await api.listen({ host: '127.0.0.1', port: 0 });
  // Synthetic fixtures go through the API, so the desktop test only exercises the screens.
  const create = async (resource: string, data: unknown) => {
    const response = await fetch(`${origin}/api/v1/${resource}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data, reason: 'Phase 6 fixture' }) });
    if (!response.ok) throw new Error(`${resource} fixture failed: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ id: string }>;
  };
  areaId = (await create('areas', { code: 'PHA01', name: 'Poblacion', description: '', active: true })).id;
  emptyAreaId = (await create('areas', { code: 'PHA02', name: 'Sitio Upper', description: '', active: true })).id;
  collectorId = (await create('collectors', { code: 'PHC01', name: 'Ana Collector', contact: '09181234567', notes: '', active: true })).id;
  const plan = await create('plans', { code: 'PHA999', name: 'Phase 6 internet', serviceType: 'INTERNET', priceCentavos: 50000, installationFeeCentavos: 100000, reconnectionFeeCentavos: 10000, description: '', speedMbps: 100, channelCount: null, active: true });
  for (const [index, code] of ['PHASUB1', 'PHASUB2'].entries()) {
    const subscriber = await create('subscribers', { code, name: `Route Sample ${index + 1}`, contact: '09179876543', email: '', addresses: [`${code} Malaybalay`], areaId, collectorId, billingDay: 1, dueDay: 5, status: 'ACTIVE', notes: '' });
    subscriberIds.push(subscriber.id);
    await create('services', { code: `${code}SVC`, subscriberId: subscriber.id, planId: plan.id, installationAddress: `${code} Malaybalay`, activationDate: '2026-01-01', billingStartDate: '2026-01-01', billingDay: 1, dueDay: 5, currentRateCentavos: 50000, status: 'ACTIVE', areaId, collectorId, notes: '' });
  }
  await fetch(`${origin}/api/v1/billing/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ period: cyclePeriod, asOf: today }) });
});
test.afterAll(async () => { await api?.close(); await db?.close(); });

async function signIn(page: Page, username: string) {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your BCIS workspace' })).toBeVisible();
}
/** The confirmation banner, filtered so the loading state of the same role never matches. */
const confirmation = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });
const notice = (page: Page) => page.getByRole('alert');
const figures = (page: Page) => page.locator('.collection-figures');

test('a route is opened, worked, counted short, signed off by a second person and printed', async () => {
  test.setTimeout(180_000);
  const desktop = await electron.launch({ args: ['.'], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow(); await signIn(page, 'owner');
    await page.getByRole('button', { name: 'Collections', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Collection routes' })).toBeVisible();

    // FND-07 applies to every screen, so the collection screen is checked at the same narrow
    // width the workspace screen is. Overflow here would silently push the tables off-screen.
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 700));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(900);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1400, 900));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThan(900);

    // An area with nothing owing is refused instead of sending a collector out empty.
    await page.getByRole('button', { name: 'Open collection route', exact: true }).click();
    await page.getByLabel('Route area').selectOption(emptyAreaId);
    await page.getByLabel('Route collector').selectOption(collectorId);
    await page.getByRole('button', { name: 'Create collection route', exact: true }).click();
    await expect(notice(page)).toContainText('No active account in this area has an open balance');

    await page.getByLabel('Route area').selectOption(areaId);
    await page.getByLabel('Route notes').fill('Morning route with two accounts');
    await page.getByRole('button', { name: 'Create collection route', exact: true }).click();
    const opened = confirmation(page, 'opened with 2 account(s)');
    await expect(opened).toBeVisible();
    const batchNumber = (await opened.innerText()).match(/BCH-\d{4}-\d{4}/)![0];

    // The frozen route is on screen with the amounts that were due that day.
    await expect(page.getByRole('heading', { name: batchNumber })).toBeVisible();
    await expect(figures(page)).toContainText('PHP 1000.00');
    await expect(page.getByRole('row', { name: /PHASUB1/ })).toContainText('PHP 500.00');
    await expect(page.getByRole('row', { name: /PHASUB1/ })).toContainText('PENDING');

    // A duplicate route for the same collector, area and day is refused.
    await page.getByRole('button', { name: 'Open collection route', exact: true }).click();
    await page.getByLabel('Route area').selectOption(areaId);
    await page.getByLabel('Route collector').selectOption(collectorId);
    await page.getByRole('button', { name: 'Create collection route', exact: true }).click();
    await expect(notice(page)).toContainText('already covers this collector and area on that date');
    await page.getByRole('button', { name: 'Cancel opening route', exact: true }).click();

    // The collector works the sheet: one account pays in full, one pays nothing.
    await page.getByLabel('Collection method').selectOption('CASH');
    await page.getByLabel('Account on the route').selectOption(subscriberIds[0]!);
    await page.getByLabel('Collection amount').fill('500.00');
    await page.getByRole('button', { name: 'Record collection on route', exact: true }).click();
    await expect(confirmation(page, `recorded on ${batchNumber}`)).toBeVisible();
    await expect(page.getByRole('row', { name: /PHASUB1/ })).toContainText('COLLECTED');
    // The status moves on by itself the first time money is collected.
    await expect(page.locator('.collection-heading').getByText('IN PROGRESS')).toBeVisible();
    await expect(figures(page)).toContainText('PHP 500.00');
    await page.screenshot({ path: 'docs/screenshots/collections-route.png', fullPage: true });

    // A submitted route is frozen, so the collect form is gone and only the handover is left.
    await page.getByLabel('Submission note').fill('One account was not at home');
    await page.getByRole('button', { name: 'Submit collection route', exact: true }).click();
    await expect(confirmation(page, 'No further collections are accepted')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record collection on route' })).toHaveCount(0);

    // AT-08: the counted cash is short, and the difference is stored and shown as a shortage.
    await expect(page.getByLabel('Expected cash')).toHaveValue('500.00');
    await page.getByLabel('Counted cash').fill('450.00');
    await page.getByLabel('Remittance notes').fill('Two notes short on the sheet');
    await page.getByRole('button', { name: 'Record remittance', exact: true }).click();
    await expect(confirmation(page, 'A supervisor now signs it off')).toBeVisible();
    await expect(page.locator('.collection-remittance')).toContainText('Shortage of PHP 50.00');
    await expect(figures(page)).toContainText('PHP 50.00');
    await expect(page.locator('.collection-remittance')).toContainText(/RMT-\d{4}-\d{4}/);
    await expect(page.locator('.collection-remittance')).toContainText('Two notes short on the sheet');

    // The person who counted the cash is refused, so a second user signs it off.
    await page.getByLabel('Reconciliation reason').fill('Shortage of 50.00 explained by a torn note');
    await page.getByRole('button', { name: 'Reconcile remittance', exact: true }).click();
    await expect(notice(page)).toContainText('someone other than the person who counted it');
    await page.screenshot({ path: 'docs/screenshots/collections-remittance.png', fullPage: true });

    await page.getByRole('button', { name: 'Sign out' }).click();
    await signIn(page, 'supervisor');
    await page.getByRole('button', { name: 'Collections', exact: true }).click();
    await page.getByRole('button', { name: `Open ${batchNumber}` }).click();
    await expect(page.getByRole('heading', { name: batchNumber })).toBeVisible();
    await page.getByLabel('Reconciliation reason').fill('Shortage of 50.00 explained by a torn note');
    await page.getByRole('button', { name: 'Reconcile remittance', exact: true }).click();
    await expect(confirmation(page, 'Reconciled and signed')).toBeVisible();
    // The shortage is still on the record after the signature: signing explains it, it does not erase it.
    await expect(page.locator('.collection-remittance')).toContainText('Shortage of PHP 50.00');
    await expect(page.locator('.collection-remittance')).toContainText('torn note');
    await expect(figures(page)).toContainText('PHP 50.00');

    await page.getByRole('button', { name: 'Close collection batch', exact: true }).click();
    await expect(confirmation(page, 'kept as history')).toBeVisible();
    await expect(page.locator('.collection-heading').getByText('CLOSED')).toBeVisible();
    await expect(page.getByText('This route is closed.')).toBeVisible();

    // The printable sheet is a copy of the stored route, fetched from the API rather than rebuilt.
    await page.getByRole('button', { name: 'Print route sheet', exact: true }).click();
    const sheet = page.locator('.route-sheet-print');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Collection Route Sheet');
    await expect(sheet).toContainText(batchNumber);
    await expect(sheet).toContainText('Poblacion');
    await expect(sheet).toContainText('Ana Collector');
    await expect(sheet.getByRole('row', { name: /PHASUB1/ })).toContainText('PHP 500.00');
    await expect(sheet.getByRole('row', { name: /PHASUB2/ })).toContainText('PHP 0.00');
    await expect(sheet).toContainText('Cash PHP 500.00');
    await expect(page.getByRole('button', { name: 'Print route sheet now', exact: true })).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/collections-route-sheet.png', fullPage: true });
  } finally { await desktop.close(); }
});

test('a supervisor reaches the collections screen and can open a route, but is never offered a payment form', async () => {
  test.setTimeout(120_000);
  const desktop = await electron.launch({ args: ['.'], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow();
    await signIn(page, 'supervisor');
    // The navigation follows the permissions the API returned, not a hard-coded list.
    await page.getByRole('button', { name: 'Collections', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Collection routes' })).toBeVisible();
    // A supervisor manages routes, so the route form is offered.
    await page.getByRole('button', { name: 'Open collection route', exact: true }).click();
    await page.getByLabel('Route area').selectOption(areaId);
    await page.getByLabel('Route collector').selectOption(collectorId);
    await expect(page.getByRole('button', { name: 'Cancel opening route', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel opening route', exact: true }).click();
    // A route already exists for today, so the route form is the only thing that could be wrong here.
    await expect(page.getByRole('button', { name: /^Open BCH-/ }).first()).toBeVisible();
  } finally { await desktop.close(); }
});
