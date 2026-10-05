import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { createTestDatabase } from '../helpers/database';
import { seedSecurity } from '../../database/seed-security';
import { AuthService } from '../../source/api/auth/service';
import { buildApp } from '../../source/api/app';

let db: Awaited<ReturnType<typeof createTestDatabase>>; let api: ReturnType<typeof buildApp>; let origin: string; let token = '';
const password = 'Synthetic-Reports-Password-123!';
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;

const clock = new Date();
const iso = (date: Date) => date.toISOString().slice(0, 10);
const today = iso(clock);
const addDays = (days: number) => iso(new Date(clock.getTime() + days * 86_400_000));

test.beforeAll(async () => {
  db = await createTestDatabase();
  await seedSecurity(db.pool, { username: 'owner', displayName: 'Owner', password });
  const auth = new AuthService(db.pool);
  token = (await auth.login('owner', password)).token;
  await auth.createUser(token, { username: 'viewer', displayName: 'Read Only', password, roles: ['VIEWER'] });
  api = buildApp({ checkDatabase: async () => undefined, auth, logLevel: 'silent' });
  origin = await api.listen({ host: '127.0.0.1', port: 0 });

  const send = (path: string, method: string, body: unknown) => fetch(`${origin}/api/v1${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const create = async (resource: string, data: unknown) => {
    const response = await send(`/${resource}`, 'POST', { data, reason: 'Phase 10 reports fixture' });
    if (!response.ok) throw new Error(`${resource} fixture failed: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ id: string }>;
  };

  const plan = await create('plans', { code: 'RPT100', name: 'Reports internet', serviceType: 'INTERNET', priceCentavos: 75000, installationFeeCentavos: 100000, reconnectionFeeCentavos: 10000, description: '', speedMbps: 100, channelCount: null, active: true });
  const area = await create('areas', { code: 'RPT10', name: 'Poblacion North', description: '', active: true });
  const collector = await create('collectors', { code: 'RPT10C', name: 'Ana Collector', contact: '09181234567', notes: '', active: true });
  const subscriber = await create('subscribers', { code: 'RPTS001', name: 'Reports Sample', contact: '09179876543', email: '', addresses: ['RPTS001 Malaybalay'], areaId: area.id, collectorId: collector.id, billingDay: 1, dueDay: 5, status: 'ACTIVE', notes: '' });
  const service = await create('services', { code: 'RPTS001SVC', subscriberId: subscriber.id, planId: plan.id, installationAddress: 'RPTS001 Malaybalay', activationDate: addDays(-90), billingStartDate: addDays(-90), billingDay: 1, dueDay: 5, currentRateCentavos: 75000, status: 'ACTIVE', areaId: area.id, collectorId: collector.id, notes: '' });

  // One invoice that is still owed (so the aging report has a row) and one that was paid
  // (so the collection figures and the dashboard are not empty).
  const owed = await send('/billing/invoices', 'POST', { serviceAccountId: service.id, issueDate: addDays(-50), dueDate: addDays(-20), items: [{ itemType: 'SUBSCRIPTION', description: 'Unpaid period', quantity: 1, unitPriceCentavos: 75000 }] });
  if (!owed.ok) throw new Error(`invoice fixture failed: ${owed.status} ${await owed.text()}`);
  const owedBody = await owed.json() as { id: string };
  await send(`/billing/invoices/${owedBody.id}/finalize`, 'POST', { reason: 'Deliberately unpaid' });

  const paid = await send('/billing/invoices', 'POST', { serviceAccountId: service.id, issueDate: addDays(-14), dueDate: addDays(-2), items: [{ itemType: 'SUBSCRIPTION', description: 'Paid period', quantity: 1, unitPriceCentavos: 75000 }] });
  if (!paid.ok) throw new Error(`invoice fixture failed: ${paid.status} ${await paid.text()}`);
  const paidBody = await paid.json() as { id: string };
  await send(`/billing/invoices/${paidBody.id}/finalize`, 'POST', { reason: 'Paid this month' });
  const payment = await send('/payments', 'POST', { subscriberId: subscriber.id, method: 'CASH', amountCentavos: 75000, receivedOn: today });
  if (!payment.ok) throw new Error(`payment fixture failed: ${payment.status} ${await payment.text()}`);
});
test.afterAll(async () => { await api?.close(); await db?.close(); });

async function signIn(page: Page, username: string) {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your BCIS workspace' })).toBeVisible();
}

test('the dashboard shows the office figures and a report can be run, read and exported', async () => {
  test.setTimeout(240_000);
  const desktop = await electron.launch({ args: ['.',], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow(); await signIn(page, 'owner');

    await page.getByRole('button', { name: 'Reports', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'How the office is doing' })).toBeVisible();
    // Six tiles, the aging split and the trend are drawn from posted rows only.
    await expect(page.locator('.kpi-card')).toHaveCount(6);
    await expect(page.locator('.aging-strip')).toContainText('90+ days');
    await expect(page.getByRole('img', { name: /Collection trend/ })).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/reports-dashboard.png', fullPage: true });

    await page.getByRole('tab', { name: 'Reports', exact: true }).click();
    await expect(page.getByRole('radiogroup', { name: 'Choose a report' })).toBeVisible();
    await expect(page.getByRole('radio')).toHaveCount(9);

    await page.getByRole('radio', { name: 'Accounts receivable aging' }).click();
    await page.getByRole('button', { name: 'Run report' }).click();
    await expect(page.getByRole('heading', { name: 'Accounts receivable aging', level: 1 })).toBeVisible();
    await expect(page.locator('.report-meta')).toBeVisible();
    await expect(page.locator('table').first()).toBeVisible();
    // The Owner may export, and the offer is the server's answer rather than a promise.
    await expect(page.getByRole('button', { name: 'Save as PDF' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save as XLSX' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save as CSV' })).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/reports-aging.png', fullPage: true });
  } finally {
    await desktop.close();
  }
});

test('a viewer runs reports but is never offered an export', async () => {
  test.setTimeout(240_000);
  const desktop = await electron.launch({ args: ['.',], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow(); await signIn(page, 'viewer');
    // The Viewer has no billing, payments or settings navigation at all.
    await expect(page.getByRole('button', { name: 'Billing', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Backups', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Reports', exact: true }).click();
    await page.getByRole('tab', { name: 'Reports', exact: true }).click();
    await page.getByRole('radio', { name: 'Collection summary' }).click();
    await page.getByRole('button', { name: 'Run report' }).click();
    await expect(page.getByRole('heading', { name: 'Collection summary', level: 1 })).toBeVisible();
    await expect(page.locator('table').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save as PDF' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Print report' })).toBeVisible();
  } finally {
    await desktop.close();
  }
});
