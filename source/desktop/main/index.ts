import 'dotenv/config';
import { app, BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSystemStatus, parseApiUrl } from './api-client';
import { isTrustedRendererUrl } from './renderer-security';
import { AuthClient } from './auth-client';

const here = dirname(fileURLToPath(import.meta.url));
const apiOrigin = parseApiUrl(process.env.BCIS_API_URL ?? 'http://127.0.0.1:3100');
const auth = new AuthClient(apiOrigin);
const rendererFile = join(here, '../renderer/index.html');
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const rendererUrl = devUrl ?? pathToFileURL(rendererFile).href;
let window: BrowserWindow | null = null;

function createWindow() {
  window = new BrowserWindow({
    title: 'BCIS Billing', width: 1280, height: 860, minWidth: 900, minHeight: 650,
    backgroundColor: '#F6F8FB', show: false, autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererUrl)) event.preventDefault();
  });
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { window = null; });
  void window.loadURL(rendererUrl);
}

// Let ESM evaluation finish before Electron emits ready (top-level await deadlocks startup).
void app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const trusted = (event: IpcMainInvokeEvent) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isTrustedRendererUrl(event.senderFrame.url, rendererUrl)) {
      throw new Error('Untrusted IPC sender.');
    }
  };
  ipcMain.handle('bcis:get-system-status', (event) => { trusted(event); return getSystemStatus(apiOrigin); });
  ipcMain.handle('bcis:login', (event, input: unknown) => { trusted(event); return auth.login(input); });
  ipcMain.handle('bcis:get-session', (event) => { trusted(event); return auth.getSession(); });
  ipcMain.handle('bcis:logout', (event) => { trusted(event); return auth.endSession('logout'); });
  ipcMain.handle('bcis:lock', (event) => { trusted(event); return auth.endSession('lock'); });
  ipcMain.handle('bcis:list-users', (event, page: unknown) => { trusted(event); return auth.listUsers(page); });
  ipcMain.handle('bcis:create-user', (event, input: unknown) => { trusted(event); return auth.createUser(input); });
  ipcMain.handle('bcis:update-user', (event, id: unknown, input: unknown) => {
    trusted(event); return auth.updateUser(id, input);
  });
  ipcMain.handle('bcis:list-plans', (event, input: unknown) => { trusted(event); return auth.listPlans(input); });
  ipcMain.handle('bcis:save-plan', (event, id: unknown, input: unknown) => { trusted(event); return auth.savePlan(id,input); });
  ipcMain.handle('bcis:list-areas', (event, input: unknown) => { trusted(event); return auth.listAreas(input); });
  ipcMain.handle('bcis:save-area', (event, id: unknown, input: unknown) => { trusted(event); return auth.saveArea(id,input); });
  ipcMain.handle('bcis:list-collectors', (event, input: unknown) => { trusted(event); return auth.listCollectors(input); });
  ipcMain.handle('bcis:save-collector', (event, id: unknown, input: unknown) => { trusted(event); return auth.saveCollector(id,input); });
  ipcMain.handle('bcis:list-subscribers', (event, input: unknown) => { trusted(event); return auth.listSubscribers(input); });
  ipcMain.handle('bcis:save-subscriber', (event, id: unknown, input: unknown) => { trusted(event); return auth.saveSubscriber(id,input); });
  ipcMain.handle('bcis:list-services', (event, input: unknown) => { trusted(event); return auth.listServices(input); });
  ipcMain.handle('bcis:save-service', (event, id: unknown, input: unknown) => { trusted(event); return auth.saveService(id,input); });
  ipcMain.handle('bcis:get-master-record', (event, resource: unknown, id: unknown) => { trusted(event); return auth.getMasterRecord(resource,id); });
  ipcMain.handle('bcis:get-master-history', (event, resource: unknown, id: unknown, page: unknown) => { trusted(event); return auth.getMasterHistory(resource,id,page); });
  ipcMain.handle('bcis:assign-subscriber', (event, id: unknown, input: unknown) => { trusted(event); return auth.assignSubscriber(id,input); });
  ipcMain.handle('bcis:assign-service', (event, id: unknown, input: unknown) => { trusted(event); return auth.assignService(id,input); });
  ipcMain.handle('bcis:list-billing-cycles', (event) => { trusted(event); return auth.listBillingCycles(); });
  ipcMain.handle('bcis:list-billing-runs', (event, page: unknown) => { trusted(event); return auth.listBillingRuns(page); });
  ipcMain.handle('bcis:generate-billing-run', (event, input: unknown) => { trusted(event); return auth.generateBillingRun(input); });
  ipcMain.handle('bcis:list-billing-invoices', (event, query: unknown) => { trusted(event); return auth.listBillingInvoices(query); });
  ipcMain.handle('bcis:get-billing-invoice', (event, id: unknown) => { trusted(event); return auth.getBillingInvoice(id); });
  ipcMain.handle('bcis:create-billing-invoice', (event, input: unknown) => { trusted(event); return auth.createBillingInvoice(input); });
  ipcMain.handle('bcis:replace-billing-invoice-items', (event, id: unknown, input: unknown) => { trusted(event); return auth.replaceBillingInvoiceItems(id,input); });
  ipcMain.handle('bcis:finalize-billing-invoice', (event, id: unknown, input: unknown) => { trusted(event); return auth.finalizeBillingInvoice(id,input); });
  ipcMain.handle('bcis:adjust-billing-invoice', (event, id: unknown, input: unknown) => { trusted(event); return auth.adjustBillingInvoice(id,input); });
  ipcMain.handle('bcis:void-billing-invoice', (event, id: unknown, input: unknown) => { trusted(event); return auth.voidBillingInvoice(id,input); });
  ipcMain.handle('bcis:sweep-overdue-invoices', (event, input: unknown) => { trusted(event); return auth.sweepOverdueInvoices(input); });
  ipcMain.handle('bcis:get-subscriber-ledger', (event, query: unknown) => { trusted(event); return auth.getSubscriberLedger(query); });
  ipcMain.handle('bcis:list-payments', (event, query: unknown) => { trusted(event); return auth.listPayments(query); });
  ipcMain.handle('bcis:get-payment', (event, id: unknown) => { trusted(event); return auth.getPayment(id); });
  ipcMain.handle('bcis:get-subscriber-account', (event, subscriberId: unknown) => { trusted(event); return auth.getSubscriberAccount(subscriberId); });
  ipcMain.handle('bcis:get-payment-proof', (event, id: unknown) => { trusted(event); return auth.getPaymentProof(id); });
  ipcMain.handle('bcis:record-payment', (event, input: unknown) => { trusted(event); return auth.recordPayment(input); });
  ipcMain.handle('bcis:verify-payment', (event, id: unknown, input: unknown) => { trusted(event); return auth.verifyPayment(id, input); });
  ipcMain.handle('bcis:void-payment', (event, id: unknown, input: unknown) => { trusted(event); return auth.voidPayment(id, input); });
  ipcMain.handle('bcis:reverse-payment', (event, id: unknown, input: unknown) => { trusted(event); return auth.reversePayment(id, input); });
  createWindow();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
