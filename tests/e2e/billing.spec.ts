import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { createTestDatabase } from '../helpers/database';
import { seedSecurity } from '../../database/seed-security';
import { AuthService } from '../../source/api/auth/service';
import { buildApp } from '../../source/api/app';
let db: Awaited<ReturnType<typeof createTestDatabase>>; let api: ReturnType<typeof buildApp>; let origin: string; let token = '';
const password = 'Synthetic-Phase4-Password-123!';
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;

test.beforeAll(async () => {
  db = await createTestDatabase();
  await seedSecurity(db.pool, { username: 'owner', displayName: 'Owner', password });
  const auth = new AuthService(db.pool);
  const owner = await auth.login('owner', password);
  token = owner.token;
  await auth.createUser(owner.token, { username: 'cashier', displayName: 'Cashier', password, roles: ['CASHIER'] });
  api = buildApp({ checkDatabase: async () => undefined, auth, logLevel: 'silent' });
  origin = await api.listen({ host: '127.0.0.1', port: 0 });
  // Synthetic fixtures are created through the API so the desktop test only exercises
  // the screens, not a private database path.
  const create = async (resource: string, data: unknown) => {
    const response = await fetch(`${origin}/api/v1/${resource}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data, reason: 'Phase 4 fixture' }) });
    if (!response.ok) throw new Error(`${resource} fixture failed: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ id: string }>;
  };
  const plan = await create('plans', { code: 'BILL999', name: 'Internet 999', serviceType: 'INTERNET', priceCentavos: 99900, installationFeeCentavos: 100000, reconnectionFeeCentavos: 10000, description: '', speedMbps: 100, channelCount: null, active: true });
  const subscriber = await create('subscribers', { code: 'SUBBILL', name: 'Billing Sample', contact: '09171234567', email: 'billing@example.test', addresses: ['Malaybalay billing address'], areaId: null, collectorId: null, billingDay: 1, dueDay: 15, status: 'ACTIVE', notes: '' });
  for (const extra of [{ code: 'SVCB001', currentRateCentavos: 99900, billingDay: 1, dueDay: 15 }, { code: 'SVCB002', currentRateCentavos: 35000, billingDay: 25, dueDay: 5 }]) {
    await create('services', { ...extra, subscriberId: subscriber.id, planId: plan.id, installationAddress: 'Malaybalay billing address', activationDate: '2026-01-01', billingStartDate: '2026-01-01', status: 'ACTIVE', areaId: null, collectorId: null, notes: '' });
  }
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

test('owner generates a period, inspects an invoice, corrects it and reads the statement', async () => {
  // The desktop launch and the full billing walkthrough need more than the default budget.
  test.setTimeout(120_000);
  const desktop = await electron.launch({ args: ['.'], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow(); await signIn(page, 'owner');
    await page.getByRole('button', { name: 'Billing', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Billing cycles' })).toBeVisible();

    await page.getByLabel('Billing period').fill('2026-09');
    await page.getByRole('button', { name: 'Generate period', exact: true }).click();
    await expect(confirmation(page, '2 invoice(s) totalling PHP 1349.00, 0 service(s) already invoiced')).toBeVisible();
    await expect(page.getByRole('row', { name: /September 2026 2026-09 2026-09-30 2 issued PHP 1349\.00/ })).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/billing-cycles.png', fullPage: true });

    // A repeated generation reuses the run and issues nothing twice.
    await page.getByLabel('Billing period').fill('2026-09');
    await page.getByRole('button', { name: 'Generate period', exact: true }).click();
    await expect(confirmation(page, '2 invoice(s) totalling PHP 1349.00, 2 service(s) already invoiced')).toBeVisible();
    await expect(confirmation(page, 'existing run reused')).toBeVisible();

    await page.getByRole('tab', { name: 'Invoices', exact: true }).click();
    await expect(page.getByRole('row', { name: /INV-2026-1001/ })).toContainText('PHP 999.00');
    await expect(page.getByRole('row', { name: /INV-2026-1002/ })).toContainText('PHP 350.00');

    await page.getByRole('button', { name: 'View INV-2026-1001', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Subscription September 2026');
    await page.screenshot({ path: 'docs/screenshots/billing-invoice.png', fullPage: true });
    await dialog.getByRole('button', { name: 'Adjust', exact: true }).click();
    await dialog.getByLabel('Adjustment type').selectOption('DEBIT');
    await dialog.getByLabel('Adjustment amount').fill('100.00');
    await dialog.getByLabel('Reason').fill('Late reconnection fee collected in the field');
    await dialog.getByRole('button', { name: 'Record adjustment', exact: true }).click();
    await expect(confirmation(page, 'Balance is now PHP 1099.00')).toBeVisible();

    await page.getByRole('tab', { name: 'Subscriber ledger', exact: true }).click();
    await page.getByLabel('Search subscriber for the ledger').fill('SUBBILL');
    await page.getByRole('button', { name: 'Open ledger for SUBBILL', exact: true }).click();
    await expect(page.getByRole('row', { name: /Invoice INV-2026-1001/ })).toContainText('PHP 999.00');
    await expect(page.getByRole('row', { name: /Invoice INV-2026-1002/ })).toContainText('PHP 350.00');
    await expect(page.getByRole('row', { name: /Debit adjustment/ })).toContainText('PHP 100.00');
    await expect(page.getByRole('row', { name: /Statement totals/ })).toContainText('PHP 1449.00');
    await page.screenshot({ path: 'docs/screenshots/billing-ledger.png', fullPage: true });
  } finally { await desktop.close(); }
});

test('cashier reads billing but cannot generate a period or raise an invoice', async () => {
  test.setTimeout(120_000);
  const desktop = await electron.launch({ args: ['.'], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow(); await signIn(page, 'cashier');
    await page.getByRole('button', { name: 'Billing', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Billing cycles' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate period', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sweep overdue', exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Invoices', exact: true }).click();
    await expect(page.getByRole('row', { name: /INV-2026-1001/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New invoice', exact: true })).toHaveCount(0);
  } finally { await desktop.close(); }
});
