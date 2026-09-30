import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { createTestDatabase } from '../helpers/database';
import { seedSecurity } from '../../database/seed-security';
import { AuthService } from '../../source/api/auth/service';
import { buildApp } from '../../source/api/app';
let db: Awaited<ReturnType<typeof createTestDatabase>>; let api: ReturnType<typeof buildApp>; let origin: string;
const password = 'Synthetic-Phase3-Password-123!';
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
test.beforeAll(async () => {
  db = await createTestDatabase(); await seedSecurity(db.pool, { username: 'owner', displayName: 'Owner', password });
  const auth = new AuthService(db.pool); const owner = await auth.login('owner', password);
  await auth.createUser(owner.token, { username: 'cashier', displayName: 'Cashier', password, roles: ['CASHIER'] });
  api = buildApp({ checkDatabase: async () => undefined, auth }); origin = await api.listen({ host: '127.0.0.1', port: 0 });
});
test.afterAll(async () => { await api?.close(); await db?.close(); });
async function signIn(page: Page, username: string) { await page.getByLabel('Username', { exact: true }).fill(username); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Your BCIS workspace' })).toBeVisible(); }
test('owner maintains plans, subscribers and multiple services with visible history', async () => {
  const desktop = await electron.launch({ args: ['.'], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow(); await signIn(page, 'owner');
    await page.getByRole('button', { name: 'Collections', exact: true }).click();
    await page.getByRole('button', { name: 'New area', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Code', { exact: true }).fill('CENTRAL');
    await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Central route');
    await page.getByRole('button', { name: 'Save record', exact: true }).click(); await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.getByRole('tab', { name: 'Collectors', exact: true }).click();
    await page.getByRole('button', { name: 'New collector', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Code', { exact: true }).fill('COL001');
    await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Sample Collector');
    await page.getByRole('button', { name: 'Save record', exact: true }).click(); await expect(page.getByRole('dialog')).not.toBeVisible();

    await page.getByRole('button', { name: 'Subscribers', exact: true }).click();
    await page.getByRole('tab', { name: 'Plans', exact: true }).click();
    await page.getByRole('button', { name: 'New plan', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Code', { exact: true }).fill('NET999'); await dialog.getByLabel('Name', { exact: true }).fill('Internet 999');
    await dialog.getByLabel('Monthly price (PHP)', { exact: true }).fill('999.00');
    await dialog.getByRole('button', { name: 'Save record', exact: true }).click(); await expect(dialog).not.toBeVisible();
    await page.getByRole('tab', { name: 'Subscribers', exact: true }).click(); await page.getByRole('button', { name: 'New subscriber', exact: true }).click();
    dialog = page.getByRole('dialog'); await dialog.getByLabel('Account number', { exact: true }).fill('SUB001'); await dialog.getByLabel('Name', { exact: true }).fill('Maria Sample');
    await dialog.getByLabel('Addresses (one per line)', { exact: true }).fill('Malaybalay home\nValencia office');
    await dialog.getByLabel('Collection area', { exact: true }).selectOption({ label: 'CENTRAL — Central route' });
    await dialog.getByLabel('Assigned collector', { exact: true }).selectOption({ label: 'COL001 — Sample Collector' });
    await page.screenshot({ path: 'docs/screenshots/subscriber-form.png', fullPage: true });
    await dialog.getByRole('button', { name: 'Save record', exact: true }).click(); await expect(dialog).not.toBeVisible();
    await page.getByRole('tab', { name: 'Service accounts', exact: true }).click();
    for (const code of ['SVC001', 'SVC002']) {
      await page.getByRole('button', { name: 'New service', exact: true }).click(); dialog = page.getByRole('dialog');
      await dialog.getByLabel('Service number', { exact: true }).fill(code);
      await dialog.getByLabel('Subscriber', { exact: true }).selectOption({ label: 'SUB001 — Maria Sample' });
      await dialog.getByLabel('Plan', { exact: true }).selectOption({ label: 'NET999 — Internet 999' });
      await dialog.getByLabel('Installation address', { exact: true }).fill('Malaybalay home');
      await dialog.getByLabel('Billing start date', { exact: true }).fill('2026-10-01');
      await dialog.getByLabel('Current rate (PHP)', { exact: true }).fill('999.00');
      await dialog.getByRole('button', { name: 'Save record', exact: true }).click(); await expect(dialog).not.toBeVisible();
    }
    await expect(page.getByRole('cell', { name: 'SVC002', exact: true })).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/services.png', fullPage: true });
    await page.getByRole('button', { name: 'History SVC001', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Initial setup'); await page.getByRole('button', { name: 'Close history', exact: true }).click();
    await page.getByRole('tab', { name: 'Subscribers', exact: true }).click(); await page.getByLabel('Search records').fill('Valencia');
    await expect(page.getByRole('cell', { name: 'Maria Sample', exact: true })).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/subscribers.png', fullPage: true });
  } finally { await desktop.close(); }
});
test('cashier can search but cannot create subscriber records', async () => {
  const desktop = await electron.launch({ args: ['.'], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow(); await signIn(page, 'cashier'); await page.getByRole('button', { name: 'Subscribers', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New subscriber', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Search records')).toBeVisible();
  } finally { await desktop.close(); }
});
