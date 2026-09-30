import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestDatabase } from '../helpers/database';
import { seedSecurity } from '../../database/seed-security';
import { AuthService } from '../../source/api/auth/service';
import { buildApp } from '../../source/api/app';

let db: Awaited<ReturnType<typeof createTestDatabase>>; let api: ReturnType<typeof buildApp>; let origin: string; let token = '';
let proofDir: string; let receiptFile: string;
const password = 'Synthetic-Phase5-Password-123!';
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;

// The smallest valid PNG. The API checks the magic bytes, so a real image is required.
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.beforeAll(async () => {
  proofDir = join(process.cwd(), 'test-results', 'phase5-proofs');
  receiptFile = join(proofDir, 'gcash-receipt.png');
  await mkdir(proofDir, { recursive: true });
  await writeFile(receiptFile, Buffer.from(pngBase64, 'base64'));
  process.env.BCIS_PROOF_DIR = proofDir;
  db = await createTestDatabase();
  await seedSecurity(db.pool, { username: 'owner', displayName: 'Owner', password });
  const auth = new AuthService(db.pool);
  const owner = await auth.login('owner', password);
  token = owner.token;
  await auth.createUser(owner.token, { username: 'cashier', displayName: 'Cashier', password, roles: ['CASHIER'] });
  api = buildApp({ checkDatabase: async () => undefined, auth });
  origin = await api.listen({ host: '127.0.0.1', port: 0 });
  // Synthetic fixtures are created through the API so the desktop test only exercises
  // the screens, not a private database path. The later due date is created first, so a
  // correct allocation has to order by due date rather than by invoice number.
  const create = async (resource: string, data: unknown) => {
    const response = await fetch(`${origin}/api/v1/${resource}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data, reason: 'Phase 5 fixture' }) });
    if (!response.ok) throw new Error(`${resource} fixture failed: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ id: string }>;
  };
  const plan = await create('plans', { code: 'PAY999', name: 'Payment test internet', serviceType: 'INTERNET', priceCentavos: 99900, installationFeeCentavos: 100000, reconnectionFeeCentavos: 10000, description: '', speedMbps: 100, channelCount: null, active: true });
  const subscriber = await create('subscribers', { code: 'PAY001', name: 'Collection Sample', contact: '09179876543', email: 'pay@example.test', addresses: ['Malaybalay collection address'], areaId: null, collectorId: null, billingDay: 1, dueDay: 10, status: 'ACTIVE', notes: '' });
  for (const extra of [{ code: 'PAYA01', currentRateCentavos: 35000, billingDay: 25, dueDay: 5 }, { code: 'PAYB02', currentRateCentavos: 99900, billingDay: 1, dueDay: 10 }]) {
    await create('services', { ...extra, subscriberId: subscriber.id, planId: plan.id, installationAddress: 'Malaybalay collection address', activationDate: '2026-01-01', billingStartDate: '2026-01-01', status: 'ACTIVE', areaId: null, collectorId: null, notes: '' });
  }
});
test.afterAll(async () => { await api?.close(); await db?.close(); delete process.env.BCIS_PROOF_DIR; await rm(proofDir, { recursive: true, force: true }); });

async function signIn(page: Page, username: string) {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your BCIS workspace' })).toBeVisible();
}
/** The confirmation banner, filtered so the loading state of the same role never matches. */
const confirmation = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });

/** The open account panel, which loads the balance the API decides. */
const accountPanel = (page: Page) => page.locator('section.payment-account');
/** One register row, matched from the start so a reversal row never shadows its original. */
const receiptRow = (page: Page, receipt: string) => page.getByRole('row', { name: new RegExp(`^${receipt}`) });

async function openAccount(page: Page) {
  await page.getByRole('button', { name: 'Payments', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Collect payment' })).toBeVisible();
  await page.getByLabel('Search subscriber to collect from').fill('PAY001');
  await page.getByRole('button', { name: 'Collect from PAY001', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'PAY001 · Collection Sample' })).toBeVisible();
  await expect(accountPanel(page).locator('.money-cell').first()).not.toHaveText('—');
}

test('cash settles the oldest due invoice first, holds an overpayment and is reversed with a new receipt', async () => {
  test.setTimeout(150_000);
  const desktop = await electron.launch({ args: ['.'], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow(); await signIn(page, 'owner');

    // The period is generated first, because collection can only settle an issued invoice.
    await page.getByRole('button', { name: 'Billing', exact: true }).click();
    await page.getByLabel('Billing period').fill('2026-09');
    await page.getByRole('button', { name: 'Generate period', exact: true }).click();
    await expect(confirmation(page, '2 invoice(s) totalling PHP 1349.00')).toBeVisible();

    await openAccount(page);
    const account = accountPanel(page);
    await expect(account).toContainText('PHP 1349.00');
    // INV-2026-1002 was issued second but is due first, so the collector sees that order.
    await expect(account.locator('.account-summary')).toContainText('2026-09-10');
    await expect(account.getByRole('row', { name: /INV-2026-1002/ })).toContainText('2026-09-10');
    await expect(account.getByRole('row', { name: /INV-2026-1002/ })).toContainText('OVERDUE');
    await expect(account.getByRole('row', { name: /INV-2026-1001/ })).toContainText('2026-10-05');
    await expect(account.getByRole('row', { name: /INV-2026-1001/ })).toContainText('UNPAID');

    await page.getByLabel('Amount received').fill('400.00');
    await expect(page.getByRole('row', { name: /INV-2026-1002 2026-09-10 PHP 400\.00 PHP 599\.00/ })).toBeVisible();
    await page.getByRole('button', { name: 'Record payment', exact: true }).click();
    await expect(confirmation(page, 'Receipt RCT-2026-1001 for PHP 400.00: PHP 400.00 applied to 1 invoice(s)')).toBeVisible();
    // The account reloads in place: the confirmation and the open account both survive.
    await expect(account).toContainText('PHP 949.00');
    await expect(page.getByRole('row', { name: /INV-2026-1002/ })).toContainText('PARTIALLY_PAID');
    await expect(page.getByLabel('Amount received')).toHaveValue('');
    await page.screenshot({ path: 'docs/screenshots/payments-collect.png', fullPage: true });

    // One payment that is larger than the remaining balance settles both invoices and the
    // excess stays on the account instead of being lost.
    await page.getByLabel('Amount received').fill('1000.00');
    await expect(page.getByRole('row', { name: /INV-2026-1002 2026-09-10 PHP 599\.00 PHP 0\.00/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /INV-2026-1001 2026-10-05 PHP 350\.00 PHP 0\.00/ })).toBeVisible();
    await page.getByRole('button', { name: 'Record payment', exact: true }).click();
    await expect(confirmation(page, 'Receipt RCT-2026-1002 for PHP 1000.00: PHP 949.00 applied to 2 invoice(s), PHP 51.00 held as advance credit')).toBeVisible();
    await expect(page.getByRole('row', { name: /INV-2026-1001/ })).toContainText('PAID');
    await expect(account).toContainText('PHP 0.00');

    await page.getByRole('tab', { name: 'Payment history' }).click();
    await expect(receiptRow(page, 'RCT-2026-1001')).toContainText('PHP 400.00');
    await expect(receiptRow(page, 'RCT-2026-1002')).toContainText('PHP 51.00');
    await page.getByRole('button', { name: 'View RCT-2026-1002', exact: true }).click();
    const dialog = page.getByRole('dialog');
    // The receipt shows exactly which invoices it settled, oldest due date first.
    await expect(dialog.getByRole('row', { name: /INV-2026-1002 Payment PHP 599\.00/ })).toBeVisible();
    await expect(dialog.getByRole('row', { name: /INV-2026-1001 Payment PHP 350\.00/ })).toBeVisible();
    await expect(dialog.getByRole('row', { name: /Total applied PHP 949\.00/ })).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/payments-receipt.png', fullPage: true });
    await dialog.getByRole('button', { name: 'Reverse', exact: true }).click();
    await dialog.getByLabel('Reversal reason').fill('Collector entered the wrong subscriber');
    await dialog.getByRole('button', { name: 'Reverse payment', exact: true }).click();
    await expect(confirmation(page, 'Reversal RCT-2026-1003 posted. 2 invoice(s) reopened.')).toBeVisible();

    // The reversal takes the money back: both invoices carry their balance again and the
    // credit the reversal freed is no longer held.
    await page.getByRole('tab', { name: 'Collect payment' }).click();
    await openAccount(page);
    await expect(accountPanel(page)).toContainText('PHP 949.00');
    await expect(accountPanel(page)).toContainText('PHP 0.00');
    await expect(page.getByRole('row', { name: /INV-2026-1002/ })).toContainText('PHP 599.00');
    await expect(page.getByRole('row', { name: /INV-2026-1002/ })).toContainText('PARTIALLY_PAID');
    await expect(page.getByRole('row', { name: /INV-2026-1001/ })).toContainText('PHP 350.00');
    await expect(page.getByRole('row', { name: /INV-2026-1001/ })).toContainText('UNPAID');

    // The reversal is its own posted document and the original receipt keeps its number.
    await page.getByRole('tab', { name: 'Payment history' }).click();
    await expect(receiptRow(page, 'RCT-2026-1003')).toContainText('reverses RCT-2026-1002');
    await expect(receiptRow(page, 'RCT-2026-1003')).toContainText('POSTED');
    await expect(receiptRow(page, 'RCT-2026-1002')).toContainText('REVERSED');
    // The reason the money was taken back is kept on the entry, not only in the log.
    await page.getByRole('button', { name: 'View RCT-2026-1002', exact: true }).click();
    const reversed = page.getByRole('dialog');
    await expect(reversed.getByText('Reason: Collector entered the wrong subscriber')).toBeVisible();
    await expect(reversed.getByText('2026-09-30').first()).toBeVisible();
  } finally { await desktop.close(); }
});

test('a GCash claim waits for a second person, a voided claim keeps its history and the receipt is issued only after confirmation', async () => {
  test.setTimeout(150_000);
  const desktop = await electron.launch({ args: ['.'], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow(); await signIn(page, 'owner');
    await openAccount(page);

    await page.getByLabel('Payment method').selectOption('GCASH');
    await page.getByLabel('Amount received').fill('200.00');
    await page.getByLabel('GCash reference number').fill('GC-PHASE5-0001');
    await page.getByLabel('GCash receipt image').setInputFiles(receiptFile);
    await expect(page.getByText('gcash-receipt.png', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Record payment', exact: true }).click();
    await expect(confirmation(page, 'GCASH payment of PHP 200.00 recorded and awaiting confirmation by another user.')).toBeVisible();

    // A second live claim needs its own reference and its own receipt image.
    await page.getByLabel('GCash reference number').fill('GC-PHASE5-0002');
    await page.getByLabel('Amount received').fill('300.00');
    await page.getByLabel('GCash receipt image').setInputFiles(receiptFile);
    await expect(page.getByText('gcash-receipt.png', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Record payment', exact: true }).click();
    await expect(confirmation(page, 'GCASH payment of PHP 300.00 recorded and awaiting confirmation by another user.')).toBeVisible();

    // The reference of a live claim is protected, so a third claim cannot reuse it.
    await page.getByLabel('GCash reference number').fill('GC-PHASE5-0001');
    await page.getByLabel('Amount received').fill('100.00');
    await page.getByLabel('GCash receipt image').setInputFiles(receiptFile);
    await page.getByRole('button', { name: 'Record payment', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('already been recorded');

    await page.getByRole('tab', { name: 'Payment history' }).click();
    // An unconfirmed claim holds no receipt and has reduced no balance.
    await expect(page.getByRole('row', { name: /Not issued/ }).first()).toContainText('PENDING');

    // The collector cannot confirm their own claim, so the screen says so and refuses.
    await page.getByRole('button', { name: 'Confirm GC-PHASE5-0001', exact: true }).click();
    const own = page.getByRole('dialog');
    await expect(own.getByText('You recorded this payment.')).toBeVisible();
    await expect(own.getByRole('button', { name: 'Confirm and post', exact: true })).toBeDisabled();
    await own.getByRole('button', { name: 'Close dialog' }).click();

    await page.getByRole('button', { name: 'Void GC-PHASE5-0002', exact: true }).click();
    const voidDialog = page.getByRole('dialog');
    await voidDialog.getByLabel('Void reason').fill('Customer withdrew the GCash claim');
    await voidDialog.getByRole('button', { name: 'Void payment', exact: true }).click();
    await expect(confirmation(page, 'Payment voided. It never held a receipt and posted nothing.')).toBeVisible();

    // A second authorised user checks the reference against the attached receipt.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await signIn(page, 'cashier');
    await page.getByRole('button', { name: 'Payments', exact: true }).click();
    await page.getByRole('tab', { name: 'Payment history' }).click();
    await page.getByRole('button', { name: 'Confirm GC-PHASE5-0001', exact: true }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm.getByRole('img', { name: /GCash receipt/ })).toBeVisible();
    await confirm.getByLabel('Confirmation note').fill('Reference 9A2B3C4D5E matches the attached receipt');
    await confirm.getByRole('button', { name: 'Confirm and post', exact: true }).click();
    await expect(confirmation(page, 'Receipt RCT-2026-1004 issued: PHP 200.00 applied to 1 invoice(s).')).toBeVisible();

    // The voided claim stays in the register with its reason, and a cashier cannot reverse.
    await expect(page.getByRole('row', { name: /GC-PHASE5-0002/ })).toContainText('VOID');
    await expect(page.getByRole('row', { name: /RCT-2026-1004/ })).toContainText('POSTED');
    await expect(page.getByRole('button', { name: /^Reverse RCT-/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'View RCT-2026-1004', exact: true }).click();
    const receipt = page.getByRole('dialog');
    await expect(receipt.getByText('confirmed by cashier')).toBeVisible();
    await expect(receipt.getByRole('row', { name: /INV-2026-1002 Payment PHP 200\.00/ })).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/payments-gcash.png', fullPage: true });
  } finally { await desktop.close(); }
});
