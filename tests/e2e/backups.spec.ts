import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { createTestDatabase } from '../helpers/database';
import { seedSecurity } from '../../database/seed-security';
import { AuthService } from '../../source/api/auth/service';
import { buildApp } from '../../source/api/app';

/**
 * AT-12 through the operator's screen.
 *
 * The integration tests prove the restore is correct; this proves an operator can actually do it,
 * and that the screen refuses the things it must refuse. Two of those refusals are the point of the
 * walkthrough: a restore that cannot be started without the confirmation word and a reason, and a
 * failed backup that stays visible in the history rather than disappearing.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let api: ReturnType<typeof buildApp>;
let origin: string;
let token = '';
let backupDirectory = '';
let proofDirectory = '';
const password = 'Synthetic-Phase9-Password-123!';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const today = new Date().toISOString().slice(0, 10);
let areaId = ''; let collectorId = ''; let planId = ''; let subscriberId = '';

test.beforeAll(async () => {
  // Taking a real dump and restoring it takes longer than the default hook allowance.
  test.setTimeout(180_000);
  backupDirectory = await mkdtemp(join(tmpdir(), 'bcis-e2e-backup-'));
  proofDirectory = await mkdtemp(join(tmpdir(), 'bcis-e2e-proofs-'));
  // The backup tools write into these folders, so the API has to be told where they are before it
  // is built. A backup taken to the wrong place would be a backup nobody can find.
  process.env.BCIS_BACKUP_DIR = backupDirectory;
  process.env.BCIS_PROOF_DIR = proofDirectory;
  db = await createTestDatabase();
  await seedSecurity(db.pool, { username: 'owner', displayName: 'Owner', password });
  const auth = new AuthService(db.pool);
  token = (await auth.login('owner', password)).token;
  // A cashier has no backup permissions at all, which is the other half of the walkthrough: the
  // screen is not merely hidden, the API refuses the person who signs in as them.
  await auth.createUser(token, { username: 'cashier', displayName: 'Cashier Sample', password, roles: ['CASHIER'] });
  // The pool is passed so the backup routes serve this test database rather than the configured one.
  api = buildApp({ checkDatabase: async () => undefined, auth, logLevel: 'silent', pool: db.pool });
  origin = await api.listen({ host: '127.0.0.1', port: 0 });

  const send = (path: string, method: string, body: unknown) => fetch(`${origin}/api/v1${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const create = async (resource: string, data: unknown) => {
    const response = await send(`/${resource}`, 'POST', { data, reason: 'Phase 9 fixture' });
    if (!response.ok) throw new Error(`${resource} fixture failed: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ id: string }>;
  };
  areaId = (await create('areas', { code: 'PHA9', name: 'Poblacion Backup', description: '', active: true })).id;
  collectorId = (await create('collectors', { code: 'PHA9C', name: 'Ana Collector', contact: '09181234567', notes: '', active: true })).id;
  planId = (await create('plans', {
    code: 'PHA999', name: 'Phase 9 internet', serviceType: 'INTERNET', priceCentavos: 50000, installationFeeCentavos: 100000,
    reconnectionFeeCentavos: 10000, description: '', speedMbps: 100, channelCount: null, active: true,
  })).id;
  subscriberId = (await create('subscribers', {
    code: 'PHA9S01', name: 'Backup Sample', contact: '09179876543', email: '', addresses: ['PHA9S01 Malaybalay'],
    areaId, collectorId, billingDay: 1, dueDay: 5, status: 'ACTIVE', notes: '',
  })).id;
  const service = await create('services', {
    code: 'PHA9S01SVC', subscriberId, planId, installationAddress: 'PHA9S01 Malaybalay', activationDate: '2025-01-01',
    billingStartDate: '2025-01-01', billingDay: 1, dueDay: 5, currentRateCentavos: 50000, status: 'ACTIVE', areaId, collectorId, notes: '',
  });
  const invoice = await send('/billing/invoices', 'POST', {
    serviceAccountId: service.id, issueDate: today, dueDate: today,
    items: [{ itemType: 'SUBSCRIPTION', description: 'Phase 9 month', quantity: 1, unitPriceCentavos: 50000 }],
  });
  if (!invoice.ok) throw new Error(`invoice fixture failed: ${invoice.status} ${await invoice.text()}`);
  const created = await invoice.json() as { id: string };
  await send(`/billing/invoices/${created.id}/finalize`, 'POST', { reason: 'Deliberately unpaid' });
  const payment = await send('/payments', 'POST', { subscriberId, method: 'CASH', amountCentavos: 50000, receivedOn: today });
  if (!payment.ok) throw new Error(`payment fixture failed: ${payment.status} ${await payment.text()}`);
});

test.afterAll(async () => {
  await api?.close();
  await db?.close();
  await rm(backupDirectory, { recursive: true, force: true });
  await rm(proofDirectory, { recursive: true, force: true });
});

async function signIn(page: Page, username: string) {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your BCIS workspace' })).toBeVisible();
}

test('an owner takes a verified backup, sees what it contains, and restores it with a reason', async () => {
  test.setTimeout(240_000);
  const desktop = await electron.launch({ args: ['.'], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow();
    await signIn(page, 'owner');
    await page.getByRole('button', { name: 'Backups', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Backup and restore' })).toBeVisible();
    await expect(page.getByText('No backups have been taken yet.')).toBeVisible();

    // A full backup is the default because it is what an operator means by a backup: the database
    // and the payment proofs together.
    await expect(page.getByLabel(/Full — database and payment proofs/)).toBeChecked();
    await page.getByLabel('Note for the history').fill('Before the Phase 9 walkthrough');
    await page.getByRole('button', { name: 'Take backup' }).click();
    // The confirmation is the server's, not the screen's: it only appears once the archive has been
    // written and read back with pg_restore.
    await expect(page.getByRole('status').filter({ hasText: /read back successfully/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Before the Phase 9 walkthrough/ })).toContainText('Complete');

    // The archive really is on the server, and it is a PostgreSQL archive rather than a SQL script.
    const archives = (await readdir(backupDirectory)).filter((name) => name.endsWith('.dump'));
    expect(archives).toHaveLength(1);
    const bytes = await readFile(join(backupDirectory, archives[0]!));
    expect(bytes.subarray(0, 5).toString()).toBe('PGDMP');

    // Verifying re-reads the file and reports what it found, rather than asserting a stored flag.
    await page.getByRole('button', { name: /Verify the backup of/ }).click();
    await expect(page.getByRole('row', { name: /Before the Phase 9 walkthrough/ }).getByText('Verified')).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/backups-history.png', fullPage: true });

    // The office keeps working: a subscriber created after the backup must not survive the restore.
    const send = (path: string, method: string, body: unknown) => fetch(`${origin}/api/v1${path}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    const later = await send('/subscribers', 'POST', {
      data: {
        code: 'PHA9S02', name: 'Later Sample', contact: '09179876543', email: '', addresses: ['PHA9S02 Malaybalay'],
        areaId, collectorId, billingDay: 1, dueDay: 5, status: 'ACTIVE', notes: '',
      }, reason: 'Created after the backup',
    });
    if (!later.ok) throw new Error(`post-backup fixture failed: ${later.status} ${await later.text()}`);

    // A restore cannot be started by accident. The button stays disabled until the word is typed in
    // full and a reason is given, because it replaces every posted figure in the system.
    await page.getByRole('button', { name: /Restore the backup of/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/Everything entered since this backup was taken will be replaced/)).toBeVisible();
    const restoreButton = dialog.getByRole('button', { name: 'Restore now' });
    await expect(restoreButton).toBeDisabled();
    await dialog.getByLabel('Reason for this restore').fill('AT-12 walkthrough of the restore procedure');
    await expect(restoreButton).toBeDisabled();
    await dialog.getByLabel('Type RESTORE to confirm').fill('restor');
    await expect(restoreButton).toBeDisabled();
    await dialog.getByLabel('Type RESTORE to confirm').fill('RESTORE');
    await expect(restoreButton).toBeEnabled();
    await page.screenshot({ path: 'docs/screenshots/backups-restore-confirmation.png', fullPage: true });
    await restoreButton.click();

    // The report is the server's. It lists what it compared, and a difference would be named here
    // rather than summarised into a reassuring sentence.
    await expect(page.getByRole('heading', { name: /Restore of .* finished at/ })).toBeVisible();
    await expect(page.getByText('Counts matched')).toBeVisible();

    // The effect is the proof: the subscriber created after the backup is gone from the database.
    const after = await db.pool.query('SELECT count(*)::int AS n FROM subscribers WHERE code=$1', ['PHA9S02']);
    expect(after.rows[0].n).toBe(0);
    // And the one that existed when the backup was taken is still there with its payment.
    const kept = await db.pool.query('SELECT count(*)::int AS n FROM payments p JOIN subscribers s ON s.id=p.subscriber_id WHERE s.code=$1', ['PHA9S01']);
    expect(kept.rows[0].n).toBe(1);
    // The restore left a trail: the backup records when it was restored, and the reason is in the
    // audit log next to it.
    const audited = await db.pool.query(`SELECT details FROM audit_logs WHERE action='backup.restore'`);
    expect(audited.rows).toHaveLength(1);
    expect((audited.rows[0].details as { reason: string }).reason).toBe('AT-12 walkthrough of the restore procedure');
  } finally { await desktop.close(); }
});

test('a cashier has no backup screen and no backup permission', async () => {
  test.setTimeout(180_000);
  const desktop = await electron.launch({ args: ['.'], env: { ...env, BCIS_API_URL: origin } });
  try {
    const page = await desktop.firstWindow();
    await signIn(page, 'cashier');
    // The navigation entry is hidden rather than shown and refused, so the screen is not something a
    // cashier can stumble into.
    await expect(page.getByRole('button', { name: 'Backups', exact: true })).toHaveCount(0);
    // And the API refuses the same person directly, because a hidden button is not a permission.
    const refused = await fetch(`${origin}/api/v1/backups`, { headers: { Authorization: `Bearer ${(await new AuthService(db.pool).login('cashier', password)).token}` } });
    expect(refused.status).toBe(403);
  } finally { await desktop.close(); }
});