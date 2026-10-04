import { test, expect, _electron as electron } from '@playwright/test';
import { buildApp } from '../../source/api/app';

const desktopEnv = { ...process.env };
delete desktopEnv.ELECTRON_RUN_AS_NODE;

test('desktop connects to the real API and isolates the renderer', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv, BCIS_API_URL: 'http://127.0.0.1:3100' } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Sign in to BCIS' })).toBeVisible();
    await expect(page.getByText('All systems connected', { exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
    const boundary = await page.evaluate(() => ({ node: typeof (globalThis as unknown as { require?: unknown }).require, bridge: Object.keys(window.bcis) }));
    expect(boundary).toEqual({ node: 'undefined', bridge: ['listPlans', 'savePlan', 'listAreas', 'saveArea', 'listCollectors', 'saveCollector', 'listSubscribers', 'saveSubscriber', 'listServices', 'saveService', 'getMasterRecord', 'getMasterHistory', 'assignSubscriber', 'assignService', 'getSystemStatus', 'login', 'getSession', 'logout', 'lock', 'listUsers', 'createUser', 'updateUser', 'listBillingCycles', 'listBillingRuns', 'generateBillingRun', 'listBillingInvoices', 'getBillingInvoice', 'createBillingInvoice', 'replaceBillingInvoiceItems', 'finalizeBillingInvoice', 'adjustBillingInvoice', 'voidBillingInvoice', 'sweepOverdueInvoices', 'getSubscriberLedger', 'listPayments', 'getPayment', 'getSubscriberAccount', 'getPaymentProof', 'recordPayment', 'verifyPayment', 'voidPayment', 'reversePayment', 'listCollectionBatches', 'getCollectionBatch', 'getCollectionRouteSheet', 'createCollectionBatch', 'startCollectionBatch', 'submitCollectionBatch', 'remitCollectionBatch', 'reconcileCollectionBatch', 'closeCollectionBatch', 'getReceivableSummary', 'listOverdueReceivables', 'getServicePolicy', 'updateServicePolicy', 'listServiceTechnicians', 'listSuspensions', 'getSuspension', 'suspendService', 'liftSuspension', 'requestReconnection', 'assignTechnician', 'completeReconnection', 'getServiceControlHistory', 'getReportCatalogue', 'getReport', 'getDashboard', 'exportReport', 'printReceipt', 'listBackups', 'createBackup', 'verifyBackup', 'restoreBackup'] });
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      // Electron exposes this diagnostic at runtime, outside its public TS interface.
      const contents = BrowserWindow.getAllWindows()[0]?.webContents as unknown as { getLastWebPreferences(): { sandbox: boolean; contextIsolation: boolean; nodeIntegration: boolean } };
      const p = contents.getLastWebPreferences();
      return { sandbox: p?.sandbox, contextIsolation: p?.contextIsolation, nodeIntegration: p?.nodeIntegration };
    });
    expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    await page.getByRole('button', { name: 'Refresh connection' }).click();
    await expect(page.getByText('All systems connected', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/connection.png', fullPage: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 700));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(900);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally { await app.close(); }
});

test('desktop shows an actionable error when the API cannot be reached', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv, BCIS_API_URL: 'http://127.0.0.1:1' } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('API unavailable', { exact: true })).toBeVisible();
    await expect(page.getByText(/Check that the server is running/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh connection' })).toBeEnabled();
  } finally { await app.close(); }
});

test('development renderer loads React and can use the trusted bridge', async () => {
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv, BCIS_API_URL: 'http://127.0.0.1:3100', ELECTRON_RENDERER_URL: 'http://127.0.0.1:5173' } });
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (error) => console.error(error.message));
    await expect(page.getByText('All systems connected', { exact: true })).toBeVisible();
  } finally { await app.close(); }
});

test('desktop distinguishes a database outage from an API outage', async () => {
  const server = buildApp({ checkDatabase: async () => { throw new Error('Database offline'); }, logLevel: 'silent' });
  const origin = await server.listen({ host: '127.0.0.1', port: 0 });
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv, BCIS_API_URL: origin } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Database needs attention', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'System connection' })).toContainText('API: Connected');
    await expect(page.getByRole('region', { name: 'System connection' })).toContainText('Database: Not ready');
  } finally { await app.close(); await server.close(); }
});
