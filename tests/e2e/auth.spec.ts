import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { createTestDatabase } from '../helpers/database';
import { seedSecurity } from '../../database/seed-security';
import { AuthService } from '../../source/api/auth/service';
import { buildApp } from '../../source/api/app';

const password = 'Desktop-Synthetic-Password-123!';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let api: ReturnType<typeof buildApp>;
let origin: string;
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
test.beforeAll(async () => {
  database = await createTestDatabase();
  await seedSecurity(database.pool, { username: 'owner', displayName: 'Test Owner', password });
  const auth = new AuthService(database.pool);
  const owner = await auth.login('owner', password);
  await auth.createUser(owner.token, { username: 'cashier', displayName: 'Test Cashier', password, roles: ['CASHIER'] });
  api = buildApp({ checkDatabase: async () => undefined, auth });
  origin = await api.listen({ host: '127.0.0.1', port: 0 });
});
test.afterAll(async () => { await api?.close(); await database?.close(); });
async function signIn(page: Page, username: string) {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your BCIS workspace' })).toBeVisible();
}

test('owner signs in, manages accounts, locks, unlocks and signs out', async () => {
  const desktop = await electron.launch({ args: ['.'], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow();
    await expect(page.getByRole('heading', { name: 'Sign in to BCIS' })).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/login.png', fullPage: true });
    await signIn(page, 'owner');
    await page.screenshot({ path: 'docs/screenshots/workspace.png', fullPage: true });
    await page.getByRole('button', { name: 'Administration', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'User accounts' })).toBeVisible();
    await page.getByRole('button', { name: 'New user' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Username', { exact: true }).fill('new-viewer');
    await dialog.getByLabel('Display name').fill('New Viewer');
    await dialog.getByLabel('Password', { exact: true }).fill(password);
    await dialog.getByLabel('Read-only Viewer', { exact: true }).check();
    await dialog.getByRole('button', { name: 'Create account' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('cell', { name: 'new-viewer', exact: true })).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/user-accounts.png', fullPage: true });
    await page.getByRole('button', { name: 'Lock workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Workspace locked' })).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Unlock workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Your BCIS workspace' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to BCIS' })).toBeVisible();
  } finally { await desktop.close(); }
});

test('cashier cannot see administration or bypass it through the preload API', async () => {
  const desktop = await electron.launch({ args: ['.'], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow();
    await signIn(page, 'cashier');
    await expect(page.getByRole('button', { name: 'Administration', exact: true })).toHaveCount(0);
    const result = await page.evaluate(() => window.bcis.listUsers(1));
    expect(result).toMatchObject({ ok: false, error: { status: 403 } });
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  } finally { await desktop.close(); }
});

test('incorrect login keeps the workspace protected and shows server feedback', async () => {
  const desktop = await electron.launch({ args: ['.'], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow();
    await page.getByLabel('Username', { exact: true }).fill('owner');
    await page.getByLabel('Password', { exact: true }).fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Username or password is incorrect');
    await expect(page.getByRole('heading', { name: 'Your BCIS workspace' })).toHaveCount(0);
  } finally { await desktop.close(); }
});
