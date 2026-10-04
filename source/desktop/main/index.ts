import 'dotenv/config';
import { app, BrowserWindow, dialog, ipcMain, session, type IpcMainInvokeEvent } from 'electron';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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
  ipcMain.handle('bcis:reverse-payment', (event, id, input) => { trusted(event); return auth.reversePayment(id, input); });
  ipcMain.handle('bcis:list-collection-batches', (event, query: unknown) => { trusted(event); return auth.listCollectionBatches(query); });
  ipcMain.handle('bcis:get-collection-batch', (event, id: unknown) => { trusted(event); return auth.getCollectionBatch(id); });
  ipcMain.handle('bcis:get-collection-route-sheet', (event, id: unknown) => { trusted(event); return auth.getCollectionRouteSheet(id); });
  ipcMain.handle('bcis:create-collection-batch', (event, input: unknown) => { trusted(event); return auth.createCollectionBatch(input); });
  ipcMain.handle('bcis:start-collection-batch', (event, id: unknown) => { trusted(event); return auth.startCollectionBatch(id); });
  ipcMain.handle('bcis:submit-collection-batch', (event, id: unknown, input: unknown) => { trusted(event); return auth.submitCollectionBatch(id, input); });
  ipcMain.handle('bcis:remit-collection-batch', (event, id: unknown, input: unknown) => { trusted(event); return auth.remitCollectionBatch(id, input); });
  ipcMain.handle('bcis:reconcile-collection-batch', (event, id: unknown, input: unknown) => { trusted(event); return auth.reconcileCollectionBatch(id, input); });
  ipcMain.handle('bcis:close-collection-batch', (event, id: unknown, input: unknown) => { trusted(event); return auth.closeCollectionBatch(id, input); });
  ipcMain.handle('bcis:get-receivable-summary', (event, query: unknown) => { trusted(event); return auth.getReceivableSummary(query); });
  ipcMain.handle('bcis:list-overdue-receivables', (event, query: unknown) => { trusted(event); return auth.listOverdueReceivables(query); });
  ipcMain.handle('bcis:get-service-policy', event => { trusted(event); return auth.getServicePolicy(); });
  ipcMain.handle('bcis:update-service-policy', (event, input: unknown) => { trusted(event); return auth.updateServicePolicy(input); });
  ipcMain.handle('bcis:list-service-technicians', event => { trusted(event); return auth.listServiceTechnicians(); });
  ipcMain.handle('bcis:list-suspensions', (event, query: unknown) => { trusted(event); return auth.listSuspensions(query); });
  ipcMain.handle('bcis:get-suspension', (event, id: unknown) => { trusted(event); return auth.getSuspension(id); });
  ipcMain.handle('bcis:suspend-service', (event, serviceAccountId: unknown, input: unknown) => { trusted(event); return auth.suspendService(serviceAccountId, input); });
  ipcMain.handle('bcis:lift-suspension', (event, id: unknown, input: unknown) => { trusted(event); return auth.liftSuspension(id, input); });
  ipcMain.handle('bcis:request-reconnection', (event, id: unknown, input: unknown) => { trusted(event); return auth.requestReconnection(id, input); });
  ipcMain.handle('bcis:assign-technician', (event, id: unknown, input: unknown) => { trusted(event); return auth.assignTechnician(id, input); });
  ipcMain.handle('bcis:complete-reconnection', (event, id: unknown, input: unknown) => { trusted(event); return auth.completeReconnection(id, input); });
  ipcMain.handle('bcis:get-service-control-history', (event, serviceAccountId: unknown) => { trusted(event); return auth.getServiceControlHistory(serviceAccountId); });
  ipcMain.handle('bcis:get-report-catalogue', (event) => { trusted(event); return auth.getReportCatalogue(); });
  ipcMain.handle('bcis:get-report', (event, code: unknown, query: unknown) => { trusted(event); return auth.getReport(code, query); });
  ipcMain.handle('bcis:get-dashboard', (event, query: unknown) => { trusted(event); return auth.getDashboard(query); });

  /**
   * Producing an export and saving it are one step here, on purpose.
   *
   * The renderer sends a report and a format and gets back a sentence. It never learns a
   * folder, never holds the bytes for longer than the call, and cannot name the file: the
   * native dialog picks the destination, and the bytes are written straight from here. A
   * renderer that could pass its own path would turn a read-only report screen into an
   * arbitrary-write primitive, so the path only ever comes from the dialog's own answer.
   */
  /**
   * Prints a receipt through the same dialog as an export.
   *
   * The cashier names the destination, and the path still only ever comes from the dialog. The
   * server has already audited the print by the time these bytes exist, so there is no second
   * record to write here and nothing to unwind if the save is cancelled.
   */
  ipcMain.handle('bcis:print-receipt', async (event, id: unknown) => {
    trusted(event);
    const result = await auth.printReceipt(id);
    if (!result.ok) return result;
    const { fileName, body } = result.data;
    const chosen = window && await dialog.showSaveDialog(window, {
      title: 'Print receipt',
      defaultPath: join(app.getPath('documents'), fileName),
      filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    });
    if (!chosen?.filePath) return { ok: true, data: { saved: false, fileName, bytes: body.length } };
    await writeFile(chosen.filePath, body);
    return { ok: true, data: { saved: true, fileName: basename(chosen.filePath), bytes: body.length } };
  });

  ipcMain.handle('bcis:export-report', async (event, code: unknown, query: unknown, format: unknown) => {
    trusted(event);
    const result = await auth.exportReport(code, query, format);
    if (!result.ok) return result;
    const { fileName, body } = result.data;
    const extension = String(format).toLowerCase();
    const label: Record<string, string> = { pdf: 'PDF documents', xlsx: 'Excel workbooks', csv: 'CSV files' };
    const chosen = window && await dialog.showSaveDialog(window, {
      title: 'Save report',
      defaultPath: join(app.getPath('documents'), fileName),
      filters: [{ name: label[extension] ?? 'Documents', extensions: [extension] }],
    });
    // A cancelled dialog is a normal outcome, not a failure to report as an error.
    if (!chosen?.filePath) return { ok: true as const, data: { saved: false, fileName } };
    try {
      await writeFile(chosen.filePath, body);
    } catch {
      return { ok: false as const, error: { status: 0, message: 'The report could not be written to that location. Check the folder is writable and try again.' } };
    }
    return { ok: true as const, data: { saved: true, fileName: basename(chosen.filePath), bytes: body.length } };
  });

// --------------------------------------------------------------------- backups
  // Unlike an export, a backup involves no dialog and no bytes here. The archive is written,
  // read back and restored by the API on the server; the desktop only forwards the request and
  // shows what came back. There is deliberately no operation that takes a folder or a file name,
  // because a renderer that could name a path could read or overwrite an archive.

  ipcMain.handle('bcis:list-backups', (event) => { trusted(event); return auth.listBackups(); });
  ipcMain.handle('bcis:create-backup', (event, input: unknown) => { trusted(event); return auth.createBackup(input); });
  ipcMain.handle('bcis:verify-backup', (event, id: unknown) => { trusted(event); return auth.verifyBackup(id); });
  ipcMain.handle('bcis:restore-backup', (event, id: unknown, input: unknown) => { trusted(event); return auth.restoreBackup(id, input); });

  createWindow();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
