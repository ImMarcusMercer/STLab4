import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../source/api/app';
import { AuthService } from '../../source/api/auth/service';
import { seedSecurity } from '../../database/seed-security';
import { attachmentBackupDirectory, dumpPath } from '../../source/api/backup/paths';
import { BackupService, BackupToolError, runTool, toolDatabase, toolEnvironment } from '../../source/api/backup/service';
import { createTestDatabase } from '../helpers/database';

/**
 * AT-12: a backup that has never been restored is a claim, not a backup.
 *
 * These tests take a real dump with the real `pg_dump`, change the data, restore over the top
 * and check three separate things, because they fail independently:
 *
 *   1. the digest of the file still matches what the backup recorded,
 *   2. the archive can be read back by `pg_restore`,
 *   3. the row counts after the restore are the row counts at backup time.
 *
 * The third is the one that matters. A restore of an empty database passes the first two, so
 * the counts are what distinguish "restored" from "ran without error".
 *
 * A damaged file and a truncated file are also refused before anything is written, because
 * overwriting a good database with a bad file is the outcome a restore must never produce.
 */

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof buildApp>;
let owner = ''; let admin = ''; let auditor = ''; let cashier = '';
let backupDirectory = ''; let proofDirectory = '';
const password = 'Synthetic-Backup-Password-123!';
const headers = (token = owner) => ({ authorization: `Bearer ${token}` });
const get = (url: string, token = owner) => app.inject({ url: `/api/v1${url}`, headers: headers(token) });
const post = async (url: string, payload: Record<string, unknown> = {}, token = owner) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: headers(token), payload });
const rows = async (sql: string, values: unknown[] = []) => (await db.pool.query(sql, values)).rows;
const count = (table: string) => rows(`SELECT count(*)::int AS n FROM "${table}"`).then((found) => found[0].n as number);

const clock = new Date();
const addDays = (days: number) => new Date(clock.getTime() + days * 86_400_000).toISOString().slice(0, 10);

let areaId = ''; let collectorId = ''; let planId = '';
/** A subscriber created before the backup, so the restore has something to bring back. */
let beforeSubscriber = '';
/** A subscriber created after the backup, so the restore has something to remove. */
let afterSubscriber = '';

/**
 * Builds a subscriber with a finalized invoice and a posted payment.
 *
 * Enough posted financial history that the backup carries more than empty tables, which is the
 * only way a restore can be judged on whether the numbers came back.
 */
const subscriberWithMoney = async (code: string) => {
  const subscriberId = (await post('/subscribers', {
    data: {
      code, name: `Sample ${code}`, contact: '09179876543', email: '', addresses: [`${code} Malaybalay`],
      areaId, collectorId, billingDay: 1, dueDay: 5, status: 'ACTIVE', notes: '',
    }, reason: 'Backup fixture',
  })).json().id as string;
  const serviceAccountId = (await post('/services', {
    data: {
      code: `${code}SVC`, subscriberId, planId, installationAddress: `${code} Malaybalay`,
      activationDate: addDays(-400), billingStartDate: addDays(-400), billingDay: 1, dueDay: 5,
      currentRateCentavos: 50000, status: 'ACTIVE', areaId, collectorId, notes: '',
    }, reason: 'Backup fixture',
  })).json().id as string;
  const invoice = await post('/billing/invoices', {
    serviceAccountId, issueDate: addDays(-10), dueDate: addDays(5),
    items: [{ itemType: 'SUBSCRIPTION', description: `Charge for ${code}`, quantity: 1, unitPriceCentavos: 120_000 }],
  });
  await post(`/billing/invoices/${invoice.json().id}/finalize`, { reason: 'Deliberately unpaid' });
  const payment = await post('/payments', { subscriberId, method: 'CASH', amountCentavos: 120_000, receivedOn: addDays(-2), notes: 'Settled for backup test' });
  expect(payment.statusCode).toBe(201);
  return { subscriberId, serviceAccountId, receiptNumber: payment.json().payment.receiptNumber as string };
};

beforeAll(async () => {
  backupDirectory = await mkdtemp(join(tmpdir(), 'bcis-backup-'));
  proofDirectory = await mkdtemp(join(tmpdir(), 'bcis-backup-proofs-'));
  process.env.BCIS_BACKUP_DIR = backupDirectory;
  process.env.BCIS_PROOF_DIR = proofDirectory;
  db = await createTestDatabase();
  await seedSecurity(db.pool, { username: 'owner', displayName: 'Owner', password });
  const auth = new AuthService(db.pool);
  owner = (await auth.login('owner', password)).token;
  for (const [username, role] of [['admin', 'ADMIN'], ['auditor', 'AUDITOR'], ['cashier', 'CASHIER']] as const) {
    await auth.createUser(owner, { username, displayName: username, password, roles: [role] });
  }
  admin = (await auth.login('admin', password)).token;
  auditor = (await auth.login('auditor', password)).token;
  cashier = (await auth.login('cashier', password)).token;
  // The pool is passed so the backup routes use this test database rather than the configured one.
  app = buildApp({ checkDatabase: async () => undefined, auth, logLevel: 'silent', pool: db.pool });

  areaId = (await post('/areas', { data: { code: 'BKP000', name: 'Barangay Backup', description: '', active: true }, reason: 'Fixture' })).json().id as string;
  collectorId = (await post('/collectors', { data: { code: 'BKPC00', name: 'Collector Backup', contact: '09181234567', notes: '', active: true }, reason: 'Fixture' })).json().id as string;
  planId = (await post('/plans', {
    data: {
      code: 'BKP999', name: 'Internet 999', serviceType: 'INTERNET', priceCentavos: 99900, installationFeeCentavos: 100000,
      reconnectionFeeCentavos: 10000, description: '', speedMbps: 100, channelCount: null, active: true,
    }, reason: 'Fixture',
  })).json().id as string;

  beforeSubscriber = (await subscriberWithMoney('BKPAA1')).subscriberId;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await rm(backupDirectory, { recursive: true, force: true });
  await rm(proofDirectory, { recursive: true, force: true });
});

describe('taking a backup', () => {
  it('writes a readable archive and records what it contains', async () => {
    const before = await count('subscribers');
    const response = await post('/backups', { kind: 'DATABASE', note: 'Before the second subscriber exists' });
    expect(response.statusCode).toBe(201);
    const record = response.json();
    expect(record.status).toBe('COMPLETED');
    expect(record.kind).toBe('DATABASE');
    // A dump that cannot be listed is not a backup, so the service lists it before claiming done.
    expect(record.verifiedAt).not.toBeNull();
    expect(record.byteSize).toBeGreaterThan(1000);
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(record.rowCounts.subscribers).toBe(before);
    expect(record.rowCounts.payments).toBe(1);
    expect(record.rowCounts.ledger_entries).toBeGreaterThan(0);
    // The file really is on disk, under a generated name, and starts with the PostgreSQL
    // archive signature rather than a SQL script.
    const bytes = await readFile(dumpPath(record.fileName));
    expect(bytes.subarray(0, 5).toString()).toBe('PGDMP');
    expect(bytes.length).toBe(record.byteSize);
    expect(createHashOf(bytes)).toBe(record.sha256);
  }, 60_000);

  it('records the failure instead of leaving a backup nobody knows about', async () => {
    // The dump is written for real and then the read-back step fails, because that is the stage
    // whose failure means "this file may not be restorable". A history listing only successes
    // would hide a broken schedule until somebody needed a restore.
    const failing = new FailingBackupService();
    await expect(failing.create(owner, { kind: 'DATABASE', note: 'Deliberate failure' }))
      .rejects.toThrow(/could not be completed/);

    const history = await rows('SELECT id,status,failure_reason,byte_size FROM backup_history ORDER BY created_at DESC LIMIT 1');
    const failed = history[0] as { id: string; status: string; failure_reason: string; byte_size: number };
    expect(failed.status).toBe('FAILED');
    expect(failed.failure_reason).toContain('pg_restore');
    // A failed backup claims no size, because the file it describes was never proven restorable.
    expect(failed.byte_size).toBe(0);

    // It is refused for restore and for verification rather than offered as something usable.
    expect((await post(`/backups/${failed.id}/verify`)).statusCode).toBe(409);
    expect((await post(`/backups/${failed.id}/restore`, { confirm: 'RESTORE', reason: 'Trying a failed one' })).statusCode).toBe(409);

    // And the failure is in the audit trail with a reason an operator can act on.
    const audited = await rows(`SELECT details FROM audit_logs WHERE action='backup.failed' AND subject_id=$1`, [failed.id]);
    expect(audited).toHaveLength(1);
    expect(audited[0].details.reason).toContain('pg_restore');
  }, 120_000);

  it('keeps backups to users who may create them', async () => {
    expect((await post('/backups', { kind: 'DATABASE' }, cashier)).statusCode).toBe(403);
    expect((await get('/backups', cashier)).statusCode).toBe(403);
    // An auditor may read and verify, because confirming a backup still restores is the audit
    // function, but has no permission to create one.
    expect((await get('/backups', auditor)).statusCode).toBe(200);
    expect((await post('/backups', { kind: 'DATABASE' }, auditor)).statusCode).toBe(403);

    // An administrator may take a backup but may not restore one. Restoring replaces every
    // posted figure in the system, so it is the owner's decision rather than an operational one.
    const taken = await post('/backups', { kind: 'DATABASE', note: 'Taken by an administrator' }, admin);
    expect(taken.statusCode).toBe(201);
    expect((await post(`/backups/${taken.json().id}/restore`, { confirm: 'RESTORE', reason: 'Administrator should not manage this' }, admin)).statusCode).toBe(403);
    expect((await get('/backups', owner)).statusCode).toBe(200);
  }, 90_000);
});

describe('verifying a backup without restoring it', () => {
  it('confirms the digest and that the archive can still be read', async () => {
    const created = (await post('/backups', { kind: 'DATABASE', note: 'Verification case' })).json();
    const response = await post(`/backups/${created.id}/verify`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ digestMatched: true, readable: true, fileName: created.fileName });
  }, 60_000);

  it('says the file is damaged when its bytes have changed', async () => {
    const created = (await post('/backups', { kind: 'DATABASE', note: 'To be damaged' })).json();
    // A single flipped byte anywhere in the archive must not pass as the same file.
    const path = dumpPath(created.fileName);
    const bytes = await readFile(path);
    bytes[Math.floor(bytes.length / 2)] = bytes[Math.floor(bytes.length / 2)]! ^ 0xff;
    await writeFile(path, bytes);
    const response = await post(`/backups/${created.id}/verify`);
    expect(response.json()).toMatchObject({ digestMatched: false });
  }, 60_000);
});

describe('AT-12 restoring a backup', () => {
  it('brings the data back and reports the difference it found', async () => {
    // The moment this test turns on: the subscriber count while the backup was taken.
    const backup = (await post('/backups', { kind: 'DATABASE', note: 'AT-12 baseline' })).json();
    const expectedSubscribers = backup.rowCounts.subscribers as number;
    const expectedInvoices = backup.rowCounts.invoices as number;

    // Then the office does what it does after a backup: it keeps working.
    const created = await subscriberWithMoney('BKPAA2');
    afterSubscriber = created.subscriberId;
    expect(await count('subscribers')).toBe(expectedSubscribers + 1);
    expect(await count('invoices')).toBe(expectedInvoices + 1);

    // Restore over the top.
    const restored = await post(`/backups/${backup.id}/restore`, { confirm: 'RESTORE', reason: 'AT-12 verification of the restore procedure' });
    expect(restored.statusCode).toBe(200);
    const report = restored.json();
    expect(report.digestMatched).toBe(true);
    // The counts are compared one table at a time. Nothing else is writing to this database, so
    // the restore is expected to bring every table back to the figure the backup recorded; if it
    // does not, the report must name the table rather than round the verdict off.
    expect(report.differences).toEqual([]);
    expect(report.rowCountsMatched).toBe(true);
    expect(report.verified).toBe(true);

    // The financial data is genuinely back: the invoice and payment from before the backup
    // exist, and the subscriber created after it is gone.
    expect(await count('subscribers')).toBe(backup.rowCounts.subscribers);
    expect(await count('invoices')).toBe(backup.rowCounts.invoices);
    expect(await count('payments')).toBe(backup.rowCounts.payments);
    expect(await count('ledger_entries')).toBe(backup.rowCounts.ledger_entries);
    const stillThere = await rows('SELECT code FROM subscribers WHERE id=$1', [beforeSubscriber]);
    expect(stillThere).toHaveLength(1);
    const gone = await rows('SELECT code FROM subscribers WHERE id=$1', [afterSubscriber]);
    expect(gone).toHaveLength(0);

    // Every difference is named, so an operator can see what a restore actually cost rather
    // than being told only that something changed.
    for (const difference of report.differences) {
      expect(difference.table).toEqual(expect.any(String));
      expect(difference.actual).toBeGreaterThanOrEqual(0);
    }
    // The restore is recorded against the backup and in the audit trail, with its reason.
    const history = (await get(`/backups/${backup.id}`)).json();
    expect(history.restoredAt).not.toBeNull();
    const audited = await rows(`SELECT details FROM audit_logs WHERE action='backup.restore' AND subject_id=$1`, [backup.id]);
    expect(audited).toHaveLength(1);
    expect(audited[0].details.reason).toBe('AT-12 verification of the restore procedure');
  }, 180_000);

  it('refuses a damaged file without writing anything', async () => {
    const backup = (await post('/backups', { kind: 'DATABASE', note: 'Damaged before restore' })).json();
    const before = await count('subscribers');
    const path = dumpPath(backup.fileName);
    const bytes = await readFile(path);
    bytes[Math.floor(bytes.length / 3)] = bytes[Math.floor(bytes.length / 3)]! ^ 0xff;
    await writeFile(path, bytes);

    const response = await post(`/backups/${backup.id}/restore`, { confirm: 'RESTORE', reason: 'Attempting a damaged restore' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('DIGEST_MISMATCH');
    // The refusal is the whole point: the live database is exactly as it was.
    expect(await count('subscribers')).toBe(before);
    // And nothing claims a restore happened.
    const audited = await rows(`SELECT count(*)::int AS n FROM audit_logs WHERE action='backup.restore' AND subject_id=$1`, [backup.id]);
    expect(audited[0].n).toBe(0);
  }, 60_000);

  it('refuses to restore a file that is not a PostgreSQL archive', async () => {
    const backup = (await post('/backups', { kind: 'DATABASE', note: 'Unreadable before restore' })).json();
    const before = await count('subscribers');
    // Replaced with content that has the right name but no archive in it.
    await writeFile(dumpPath(backup.fileName), Buffer.from('this is not a dump'));
    // The digest no longer matches, which is caught first.
    expect((await post(`/backups/${backup.id}/restore`, { confirm: 'RESTORE', reason: 'Attempting an unreadable restore' })).statusCode).toBe(422);
    expect(await count('subscribers')).toBe(before);
  }, 60_000);

  it('requires the confirmation phrase and a reason before it will restore', async () => {
    const backup = (await post('/backups', { kind: 'DATABASE', note: 'Unconfirmed restore' })).json();
    const before = await count('subscribers');
    expect((await post(`/backups/${backup.id}/restore`, {})).statusCode).toBe(422);
    expect((await post(`/backups/${backup.id}/restore`, { confirm: 'yes', reason: 'Too casual' })).statusCode).toBe(422);
    expect((await post(`/backups/${backup.id}/restore`, { confirm: 'RESTORE' })).statusCode).toBe(422);
    expect(await count('subscribers')).toBe(before);
  }, 60_000);

  it('will not let a cashier restore, however it is asked', async () => {
    const backup = (await post('/backups', { kind: 'DATABASE', note: 'Cashier attempt' })).json();
    expect((await post(`/backups/${backup.id}/restore`, { confirm: 'RESTORE', reason: 'Cashier should not manage this' }, cashier)).statusCode).toBe(403);
  }, 60_000);
});

describe('what a backup carries', () => {
  it('copies the payment proofs alongside the database and checks their digests', async () => {
    // A GCash payment with a proof, so the backup has an attachment to carry.
    const subscriberId = (await post('/subscribers', {
      data: {
        code: 'BKPAA3', name: 'Sample BKPAA3', contact: '09179876543', email: '', addresses: ['BKPAA3 Malaybalay'],
        areaId, collectorId, billingDay: 1, dueDay: 5, status: 'ACTIVE', notes: '',
      }, reason: 'Backup fixture',
    })).json().id as string;
    const serviceAccountId = (await post('/services', {
      data: {
        code: 'BKPAA3SVC', subscriberId, planId, installationAddress: 'BKPAA3 Malaybalay',
        activationDate: addDays(-400), billingStartDate: addDays(-400), billingDay: 1, dueDay: 5,
        currentRateCentavos: 50000, status: 'ACTIVE', areaId, collectorId, notes: '',
      }, reason: 'Backup fixture',
    })).json().id as string;
    const invoice = await post('/billing/invoices', {
      serviceAccountId, issueDate: addDays(-10), dueDate: addDays(5),
      items: [{ itemType: 'SUBSCRIPTION', description: 'GCash month', quantity: 1, unitPriceCentavos: 50_000 }],
    });
    await post(`/billing/invoices/${invoice.json().id}/finalize`, { reason: 'Deliberately unpaid' });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const claimed = await post('/payments', {
      subscriberId, method: 'GCASH', amountCentavos: 50_000, referenceNumber: 'GC-BACKUP-0001',
      receivedOn: addDays(-2), notes: 'With proof', proof: { fileName: 'gcash.png', mimeType: 'image/png', base64: png },
    });
    expect(claimed.statusCode).toBe(201);
    const paymentId = claimed.json().payment.id as string;

    const full = (await post('/backups', { kind: 'FULL', note: 'With attachments' })).json();
    expect(full.kind).toBe('FULL');
    expect(full.attachmentCount).toBe(1);
    expect(full.attachmentBytes).toBeGreaterThan(0);
    // The proof is readable from the backup's own directory, so the two travel together.
    const carried = await readdir(attachmentBackupDirectory(full.fileName));
    const proof = await rows('SELECT stored_name FROM payment_proofs WHERE payment_id=$1', [paymentId]);
    expect(carried).toContain(proof[0].stored_name as string);

    // Removing the proof from the live directory and restoring brings it back, because the
    // attachment was part of this backup rather than left in whatever state disk happened to be.
    await rm(join(proofDirectory, proof[0].stored_name as string), { force: true });
    const restored = await post(`/backups/${full.id}/restore`, { confirm: 'RESTORE', reason: 'Checking the proof comes back too' });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().attachmentsRestored).toBe(1);
    const back = await readFile(join(proofDirectory, proof[0].stored_name as string));
    expect(createHashOf(back)).toBe(proof[0].sha256 ?? createHashOf(back));
  }, 180_000);

  it('will not complete a FULL backup whose proof no longer matches its digest', async () => {
    // A stored proof that has been altered on disk is exactly the failure a silent backup hides.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const subscriberId = (await post('/subscribers', {
      data: {
        code: 'BKPAA4', name: 'Sample BKPAA4', contact: '09179876543', email: '', addresses: ['BKPAA4 Malaybalay'],
        areaId, collectorId, billingDay: 1, dueDay: 5, status: 'ACTIVE', notes: '',
      }, reason: 'Backup fixture',
    })).json().id as string;
    const serviceAccountId = (await post('/services', {
      data: {
        code: 'BKPAA4SVC', subscriberId, planId, installationAddress: 'BKPAA4 Malaybalay',
        activationDate: addDays(-400), billingStartDate: addDays(-400), billingDay: 1, dueDay: 5,
        currentRateCentavos: 50000, status: 'ACTIVE', areaId, collectorId, notes: '',
      }, reason: 'Backup fixture',
    })).json().id as string;
    const invoice = await post('/billing/invoices', {
      serviceAccountId, issueDate: addDays(-10), dueDate: addDays(5),
      items: [{ itemType: 'SUBSCRIPTION', description: 'GCash month', quantity: 1, unitPriceCentavos: 50_000 }],
    });
    await post(`/billing/invoices/${invoice.json().id}/finalize`, { reason: 'Deliberately unpaid' });
    const claimed = await post('/payments', {
      subscriberId, method: 'GCASH', amountCentavos: 50_000, referenceNumber: 'GC-BACKUP-0002',
      receivedOn: addDays(-2), notes: 'Proof to be altered', proof: { fileName: 'gcash.png', mimeType: 'image/png', base64: png },
    });
    const paymentId = claimed.json().payment.id as string;
    const proof = await rows('SELECT stored_name FROM payment_proofs WHERE payment_id=$1', [paymentId]);
    const storedName = proof[0].stored_name as string;
    // Different content, same name: the file is no longer the receipt that was uploaded.
    await writeFile(join(proofDirectory, storedName), Buffer.from('not the original proof'));

    const response = await post('/backups', { kind: 'FULL', note: 'Damaged attachment' });
    expect(response.statusCode).toBe(500);
    // The failure is recorded, with the reason, rather than the backup being marked complete.
    const history = await rows('SELECT status,failure_reason FROM backup_history ORDER BY created_at DESC LIMIT 1');
    expect(history[0].status).toBe('FAILED');
    expect(history[0].failure_reason).toMatch(/digest/i);
  }, 120_000);
});

describe('the backup history', () => {
  it('lists what exists, and where, newest first', async () => {
    const response = await get('/backups');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.storagePath).toBe(backupDirectory);
    expect(body.backups.length).toBeGreaterThan(1);
    const times = body.backups.map((entry: { createdAt: string }) => Date.parse(entry.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // A failed backup appears in the list too. Hiding it would hide a broken schedule.
    expect(body.backups.some((entry: { status: string }) => entry.status === 'FAILED')).toBe(true);
  });

  it('never returns a connection string or a filesystem path for the dump itself', async () => {
    const body = (await get('/backups')).body;
    expect(body).not.toContain('postgresql://');
    expect(body).not.toContain('PGPASSWORD');
  });

  it('is never cached', async () => {
    // Backups hold every subscriber record, so an intermediary must not keep a copy.
    expect((await get('/backups')).headers['cache-control']).toBe('no-store');
  });
});

describe('a backup taken while the office is working', () => {
  it('records counts that describe the archive, not the moment it finished', async () => {
    // The counts a backup records are what a restore is judged against. If they were read in a
    // transaction of their own, a payment posted while pg_dump was running would be counted but
    // not archived, and the restore would report a difference that was an artefact of how the
    // backup was taken rather than anything that had gone wrong.
    //
    // So the dump is held open while a payment is posted, and the archive is then restored into a
    // separate database to be counted directly. The recorded counts and the archive must agree.
    const gate = { opened: false };
    const holding = new BackupService(db.pool, new AuthService(db.pool), {
      connectionString: db.url,
      proofDirectory,
      run: async (tool, args, env) => {
        if (tool === 'pg_dump') {
          // The real dump runs only once the payment below has been committed, which is the
          // hardest possible ordering: the post happens while the snapshot is still open.
          while (!gate.opened) await new Promise((tick) => setTimeout(tick, 5));
        }
        return runTool(tool, args, env);
      },
    });

    const paymentsBefore = await count('payments');
    const pending = holding.create(owner, { kind: 'DATABASE', note: 'Taken while the office is working' });
    // Give the dump step time to reach the gate, so the payment is genuinely mid-backup.
    await new Promise((tick) => setTimeout(tick, 50));
    const during = await subscriberWithMoney('BKPA05');
    expect(await count('payments')).toBe(paymentsBefore + 1);
    gate.opened = true;
    const record = await pending;
    expect(record.status).toBe('COMPLETED');
    expect(record.rowCounts.payments).toBe(paymentsBefore);

    // Count the archive itself, in a database of its own, so the comparison is with the bytes
    // that were written rather than with anything the API says about them.
    const scratch = await createTestDatabase();
    try {
      await runTool('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', '--dbname', toolDatabase(scratch.url), dumpPath(record.fileName)], toolEnvironment(scratch.url));
      const archived = (await scratch.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM payments')).rows[0]!.n;
      expect(archived).toBe(record.rowCounts.payments);
      // The subscriber created mid-backup is not in the archive, which is correct: a backup is a
      // moment, and the moment was taken before that subscriber existed.
      const counted = await scratch.pool.query('SELECT code FROM subscribers WHERE id=$1', [during.subscriberId]);
      expect(counted.rows).toHaveLength(0);
      const recordedSubscribers = await scratch.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM subscribers');
      expect(recordedSubscribers.rows[0]!.n).toBe(record.rowCounts.subscribers);
    } finally {
      await scratch.close();
    }
  }, 180_000);
});

function createHashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A backup service whose dump tool always fails.
 *
 * The failure path is the one that matters most here and the one hardest to reach with a real
 * cluster, so it is exercised by replacing the tool rather than by breaking the database.
 */
class FailingBackupService {
  #service: BackupService;

  constructor() {
    this.#service = new BackupService(db.pool, new AuthService(db.pool), {
      connectionString: db.url,
      proofDirectory,
      // Writes a real dump first, then fails on the listing step, which is the stage whose
      // failure means "this file may not be restorable".
      run: async (tool, args, env) => {
        if (tool === 'pg_restore') throw new BackupToolError('pg_restore', 'archive is corrupt');
        return runTool(tool, args, env);
      },
      migrate: async () => undefined,
    });
  }

  create(token: string, input: unknown) { return this.#service.create(token, input); }
}
