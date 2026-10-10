import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { AuthClient, attachmentName } from '../../source/desktop/main/auth-client';
import { DashboardSchema, ReportTableSchema, emptyTable } from '../../source/shared/reports';

const actor = { id: '11111111-1111-4111-8111-111111111111', username: 'owner', displayName: 'Owner', active: true, roles: ['OWNER'], permissions: ['user.manage'] };
describe('desktop session boundary', () => {
  it('keeps an HTTP failure distinct from a lost connection when the response is not JSON', async () => {
    const api = Fastify();
    api.post('/api/v1/auth/login', (_, reply) => reply.code(503).type('text/plain').send('temporarily unavailable'));
    const url = await api.listen({ host: '127.0.0.1', port: 0 });
    try {
      const result = await new AuthClient(url).login({ username: 'owner', password: 'synthetic-password' });
      expect(result).toEqual({ ok: false, error: { status: 503, message: 'The office system could not complete the request. Try again or contact your administrator.' } });
    } finally { await api.close(); }
  });
  it('keeps the token in main, sends it to the API, and clears it after revocation', async () => {
    const api = Fastify();
    const token = 'a'.repeat(64);
    api.post('/api/v1/auth/login', () => ({ token, user: actor }));
    api.get('/api/v1/auth/me', (request, reply) => request.headers.authorization === `Bearer ${token}` ? actor : reply.code(401).send({}));
    api.post('/api/v1/auth/lock', (_, reply) => reply.code(204).send());
    const url = await api.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = new AuthClient(url);
      const result = await client.login({ username: 'owner', password: 'synthetic-password' });
      expect(result).toEqual({ ok: true, data: actor });
      expect(JSON.stringify(result)).not.toContain(token);
      expect(await client.getSession()).toEqual({ ok: true, data: actor });
      expect(await client.endSession('lock')).toEqual({ ok: true, data: null });
      expect(await client.getSession()).toEqual({ ok: true, data: null });
    } finally { await api.close(); }
  });
  it('clears the local session if the server returns 401', async () => {
    const api = Fastify();
    api.post('/api/v1/auth/login', () => ({ token: 'b'.repeat(64), user: actor }));
    api.get('/api/v1/auth/me', (_, reply) => reply.code(401).send({ error: { message: 'Expired' } }));
    const url = await api.listen({ host: '127.0.0.1', port: 0 });
    try {
      const client = new AuthClient(url);
      await client.login({ username: 'owner', password: 'synthetic-password' });
      expect(await client.getSession()).toMatchObject({ ok: false, error: { status: 401 } });
      expect(await client.getSession()).toEqual({ ok: true, data: null });
    } finally { await api.close(); }
  });
  it('clears the local session even when remote logout cannot be confirmed', async () => {
    const api = Fastify();
    api.post('/api/v1/auth/login', () => ({ token: 'c'.repeat(64), user: actor }));
    const url = await api.listen({ host: '127.0.0.1', port: 0 });
    const client = new AuthClient(url);
    await client.login({ username: 'owner', password: 'synthetic-password' });
    await api.close();
    expect(await client.endSession('logout')).toMatchObject({ ok: false });
    expect(await client.getSession()).toEqual({ ok: true, data: null });
  });
});

describe('the report boundary', () => {
  const dashboard = DashboardSchema.parse({
    asOf: '2026-10-01', generatedAt: '2026-10-01T00:00:00.000Z', monthLabel: 'October 2026',
    monthStart: '2026-10-01', monthEnd: '2026-10-31', kpis: [], billingVsCollection: [], paymentMethods: [],
    aging: [], collectors: [], recentPayments: [], overdueAlerts: [], receivableTotalCentavos: 0,
  });
  const table = ReportTableSchema.parse(emptyTable({
    code: 'AR_AGING', from: '2026-10-01', to: '2026-10-01', generatedAt: '2026-10-01T00:00:00.000Z', generatedBy: 'Owner',
  }));

  const signedIn = async (api: ReturnType<typeof Fastify>) => {
    const url = await api.listen({ host: '127.0.0.1', port: 0 });
    const client = new AuthClient(url);
    await client.login({ username: 'owner', password: 'synthetic-password' });
    return { client, close: () => api.close() };
  };

  it('carries the session token to the API and never returns it to the renderer', async () => {
    const api = Fastify();
    const token = 'd'.repeat(64);
    api.post('/api/v1/auth/login', () => ({ token, user: actor }));
    api.get('/api/v1/dashboard', (request, reply) => request.headers.authorization === `Bearer ${token}` ? dashboard : reply.code(401).send({}));
    const { client, close } = await signedIn(api);
    try {
      const result = await client.getDashboard();
      expect(result).toEqual({ ok: true, data: dashboard });
      expect(JSON.stringify(result)).not.toContain(token);
      // Only the filters the caller actually set reach the URL.
      expect((await client.getDashboard({ to: '2026-10-01' })).ok).toBe(true);
    } finally { await close(); }
  });

  it('refuses a dashboard filter the dashboard cannot honour, rather than dropping it', async () => {
    const api = Fastify();
    api.post('/api/v1/auth/login', () => ({ token: 'e'.repeat(64), user: actor }));
    const { client, close } = await signedIn(api);
    try {
      const result = await client.getDashboard({ from: '2026-01-01', to: '2026-10-01' });
      expect(result).toMatchObject({ ok: false, error: { status: 422 } });
      expect(result.ok ? '' : result.error.message).toMatch(/one date only/);
    } finally { await close(); }
  });

  it('asks for a report the server published, and rejects a report that does not exist', async () => {
    const api = Fastify();
    api.post('/api/v1/auth/login', () => ({ token: 'f'.repeat(64), user: actor }));
    api.get('/api/v1/reports/AR_AGING', () => table);
    const { client, close } = await signedIn(api);
    try {
      expect(await client.getReport('AR_AGING', { from: '2026-10-01', to: '2026-10-01' })).toEqual({ ok: true, data: table });
      expect(await client.getReport('NOT_A_REPORT')).toMatchObject({ ok: false, error: { status: 404 } });
      // A start date after the end date is the user's mistake, so it is named rather than sent.
      expect(await client.getReport('AR_AGING', { from: '2026-10-02', to: '2026-10-01' })).toMatchObject({ ok: false, error: { status: 422 } });
    } finally { await close(); }
  });

  it('brings an export back as bytes and the name the server suggested', async () => {
    const api = Fastify();
    api.post('/api/v1/auth/login', () => ({ token: 'g'.repeat(64), user: actor }));
    api.get('/api/v1/reports/AR_AGING/export', (request, reply) => reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', 'attachment; filename="BCIS-ar-aging-2026-10-01.pdf"')
      .send(Buffer.from('%PDF-1.4 not really')));
    const { client, close } = await signedIn(api);
    try {
      const result = await client.exportReport('AR_AGING', {}, 'PDF');
      expect(result.ok && result.data.fileName).toBe('BCIS-ar-aging-2026-10-01.pdf');
      expect(result.ok && result.data.body.subarray(0, 5).toString()).toBe('%PDF-');
      expect(await client.exportReport('AR_AGING', {}, 'DOC')).toMatchObject({ ok: false, error: { status: 422 } });
    } finally { await close(); }
  });

  it('reports an export failure instead of returning an empty file', async () => {
    const api = Fastify();
    api.post('/api/v1/auth/login', () => ({ token: 'h'.repeat(64), user: actor }));
    api.get('/api/v1/reports/AR_AGING/export', (_, reply) => reply.code(403).send({ error: { message: 'You cannot export reports.' } }));
    const { client, close } = await signedIn(api);
    try {
      const result = await client.exportReport('AR_AGING', {}, 'CSV');
      expect(result).toEqual({ ok: false, error: { status: 403, message: 'You cannot export reports.' } });
    } finally { await close(); }
  });
});

/** Starts a real API on a loopback port and signs a client in against it. */
const signedIn = async (api: ReturnType<typeof Fastify>) => {
  const url = await api.listen({ host: '127.0.0.1', port: 0 });
  const client = new AuthClient(url);
  await client.login({ username: 'owner', password: 'synthetic-password' });
  return { client, close: () => api.close() };
};

describe('the receipt boundary', () => {
  const paymentId = '0c1e6a2a-9d3f-4a77-9f2b-6d0f1c4e8b55';

  it('brings the official receipt back as bytes under the numbered name', async () => {
    const api = Fastify();
    api.post('/api/v1/auth/login', () => ({ token: 'i'.repeat(64), user: actor }));
    api.get(`/api/v1/payments/:id/receipt`, (request, reply) => {
      // The server's suggested name is the one that matters, because it carries the receipt
      // number the customer will quote when they come back about this payment.
      expect((request.params as { id: string }).id).toBe(paymentId);
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', 'attachment; filename="RCPT-2026-000145.pdf"')
        .send(Buffer.from('%PDF-1.4 receipt'));
    });
    const { client, close } = await signedIn(api);
    try {
      const result = await client.printReceipt(paymentId);
      expect(result.ok && result.data.fileName).toBe('RCPT-2026-000145.pdf');
      expect(result.ok && result.data.body.subarray(0, 5).toString()).toBe('%PDF-');
    } finally { await close(); }
  });

  it('refuses an id that is not a payment before spending a request on it', async () => {
    const api = Fastify();
    api.post('/api/v1/auth/login', () => ({ token: 'j'.repeat(64), user: actor }));
    let called = false;
    api.get(`/api/v1/payments/:id/receipt`, (_, reply) => { called = true; return reply.send(Buffer.alloc(0)); });
    const { client, close } = await signedIn(api);
    try {
      expect(await client.printReceipt('not-a-uuid')).toMatchObject({ ok: false, error: { status: 422 } });
      expect(called).toBe(false);
    } finally { await close(); }
  });

  it('passes the reason a receipt was refused straight through to the cashier', async () => {
    // The overflow refusal names the statement of account as the way out. Replacing that with a
    // generic failure would leave the cashier with nothing to act on at the counter.
    const reason = 'This receipt does not fit one page. Print the subscriber statement of account instead.';
    const api = Fastify();
    api.post('/api/v1/auth/login', () => ({ token: 'k'.repeat(64), user: actor }));
    api.get(`/api/v1/payments/:id/receipt`, (_, reply) => reply.code(422).send({ error: { message: reason } }));
    const { client, close } = await signedIn(api);
    try {
      expect(await client.printReceipt(paymentId)).toEqual({ ok: false, error: { status: 422, message: reason } });
    } finally { await close(); }
  });

  it('does not hand back a receipt the server could not build', async () => {
    const api = Fastify();
    api.post('/api/v1/auth/login', () => ({ token: 'l'.repeat(64), user: actor }));
    api.get(`/api/v1/payments/:id/receipt`, (_, reply) => reply.header('Content-Type', 'application/pdf').send(Buffer.alloc(0)));
    const { client, close } = await signedIn(api);
    try {
      expect(await client.printReceipt(paymentId)).toMatchObject({ ok: false, error: { status: 0 } });
    } finally { await close(); }
  });

  it('forgets the session token when the server rejects the receipt request', async () => {
    const api = Fastify();
    api.post('/api/v1/auth/login', () => ({ token: 'm'.repeat(64), user: actor }));
    api.get(`/api/v1/payments/:id/receipt`, (_, reply) => reply.code(401).send({ error: { message: 'Session expired.' } }));
    const offered: (string | undefined)[] = [];
    api.get('/api/v1/reports', (request, reply) => {
      offered.push(request.headers.authorization);
      return reply.send({ error: { message: 'Sign in again.' } });
    });
    const { client, close } = await signedIn(api);
    try {
      expect(await client.printReceipt(paymentId)).toMatchObject({ ok: false, error: { status: 401 } });
      await client.getReportCatalogue();
      // The stale token is dropped rather than replayed at every later request, so a closed
      // session cannot keep appearing signed in until the app is restarted.
      expect(offered[0]).toBeUndefined();
    } finally { await close(); }
  });
});

/**
 * The backup boundary.
 *
 * A backup archive is every subscriber record the office has, so the desktop client is the one
 * place that must not be able to reach it. These tests hold that line from both sides: nothing
 * comes back but the server's own account of what it did, and nothing goes out that could name a
 * file. The confirmation phrase is checked here as well as on the API, because a boundary that
 * trusts the renderer to remember it is not a boundary.
 */
describe('the backup boundary', () => {
  const backupId = '7f2c1d64-3b8a-4f21-9c0e-5a6d7e8f9a01';
  const record = {
    id: backupId, kind: 'FULL', fileName: '7f2c1d64-3b8a-4f21-9c0e-5a6d7e8f9a01.dump', byteSize: 4096,
    sha256: 'a'.repeat(64), rowCounts: { subscribers: 12, payments: 40 }, attachmentCount: 3, attachmentBytes: 900,
    note: 'October', status: 'COMPLETED', failureReason: '', createdBy: null, createdAt: '2026-10-01T02:00:00.000Z',
    verifiedAt: '2026-10-01T02:00:05.000Z', restoredAt: null, restoredBy: null,
  };
  const login = (api: ReturnType<typeof Fastify>, token: string) => { api.post('/api/v1/auth/login', () => ({ token, user: actor })); };

  it('asks for the history and shows what the server reported', async () => {
    const api = Fastify();
    login(api, 'b'.repeat(64));
    let asked = '';
    api.get('/api/v1/backups', (request) => { asked = request.url; return { backups: [record], storagePath: 'C:\\bcis-backups' }; });
    const { client, close } = await signedIn(api);
    try {
      const result = await client.listBackups();
      expect(asked).toBe('/api/v1/backups');
      expect(result.ok && result.data.backups[0]?.attachmentCount).toBe(3);
      expect(result.ok && result.data.storagePath).toBe('C:\\bcis-backups');
    } finally { await close(); }
  });

  it('rejects a history the server could not have produced', async () => {
    // A backup record with no digest, or a size that is not a whole number, is not something this
    // API writes. Treating it as data would let a compromised or mistaken server put words in the
    // operator's face about a backup that does not exist.
    const api = Fastify();
    login(api, 'b'.repeat(64));
    api.get('/api/v1/backups', () => ({ backups: [{ ...record, sha256: 'not-a-digest' }], storagePath: 'C:\\bcis-backups' }));
    const { client, close } = await signedIn(api);
    try {
      expect(await client.listBackups()).toMatchObject({ ok: false, error: { status: 0 } });
    } finally { await close(); }
  });

  it('sends the kind and the note, and nothing about a path', async () => {
    const api = Fastify();
    login(api, 'b'.repeat(64));
    let sent: unknown;
    api.post('/api/v1/backups', (request, reply) => { sent = request.body; reply.code(201); return record; });
    const { client, close } = await signedIn(api);
    try {
      const result = await client.createBackup({ kind: 'FULL', note: 'October' });
      expect(sent).toEqual({ kind: 'FULL', note: 'October' });
      expect(JSON.stringify(sent)).not.toMatch(/path|folder|directory/i);
      expect(result.ok && result.data.status).toBe('COMPLETED');
    } finally { await close(); }
  });

  it('refuses a backup request that names something the server did not offer', async () => {
    const api = Fastify();
    login(api, 'b'.repeat(64));
    let called = false;
    api.post('/api/v1/backups', (_, reply) => { called = true; reply.code(201); return record; });
    const { client, close } = await signedIn(api);
    try {
      expect(await client.createBackup({ kind: 'EVERYTHING', note: '', path: 'C:\\Windows' })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(called).toBe(false);
    } finally { await close(); }
  });

  it('will not let a restore through without the confirmation word and a reason', async () => {
    const api = Fastify();
    login(api, 'b'.repeat(64));
    let called = false;
    api.post(`/api/v1/backups/:id/restore`, () => { called = true; return {}; });
    const { client, close } = await signedIn(api);
    try {
      // A renderer that forgot the phrase must not be able to trigger a restore that replaces
      // every posted figure in the system.
      expect(await client.restoreBackup(backupId, { confirm: 'restore', reason: 'Testing' })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.restoreBackup(backupId, { confirm: 'RESTORE' })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.restoreBackup('not-a-uuid', { confirm: 'RESTORE', reason: 'Testing' })).toMatchObject({ ok: false, error: { status: 404 } });
      expect(called).toBe(false);
    } finally { await close(); }
  });

  it('shows a restore report that disagrees with the backup, rather than tidying it away', async () => {
    // The one case where a desktop must not be reassuring: the restore finished, but a table did
    // not come back to the count the backup recorded.
    const api = Fastify();
    login(api, 'b'.repeat(64));
    api.post(`/api/v1/backups/:id/restore`, () => ({
      fileName: record.fileName, verified: false, digestMatched: true, rowCountsMatched: false,
      differences: [{ table: 'subscribers', expected: 12, actual: 9 }], attachmentsRestored: 3, restoredAt: '2026-10-02T01:00:00.000Z',
    }));
    const { client, close } = await signedIn(api);
    try {
      const result = await client.restoreBackup(backupId, { confirm: 'RESTORE', reason: 'Recovering from a bad deploy' });
      expect(result.ok && result.data.verified).toBe(false);
      expect(result.ok && result.data.differences[0]).toEqual({ table: 'subscribers', expected: 12, actual: 9 });
    } finally { await close(); }
  });

  it('passes the refusal straight through when the file is damaged', async () => {
    const api = Fastify();
    login(api, 'b'.repeat(64));
    api.post(`/api/v1/backups/:id/restore`, (_, reply) => reply.code(422).send({ error: { message: 'This backup file does not match its recorded digest. Nothing has been restored; treat the file as damaged.' } }));
    const { client, close } = await signedIn(api);
    try {
      const result = await client.restoreBackup(backupId, { confirm: 'RESTORE', reason: 'Attempting a damaged restore' });
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.error.message).toContain('Nothing has been restored');
    } finally { await close(); }
  });

  it('reports a verification rather than deciding it', async () => {
    const api = Fastify();
    login(api, 'b'.repeat(64));
    api.post(`/api/v1/backups/:id/verify`, () => ({ fileName: record.fileName, digestMatched: false, readable: false, checkedAt: '2026-10-03T01:00:00.000Z' }));
    const { client, close } = await signedIn(api);
    try {
      const result = await client.verifyBackup(backupId);
      expect(result.ok && result.data.digestMatched).toBe(false);
      expect(result.ok && result.data.readable).toBe(false);
    } finally { await close(); }
  });

  it('waits for the server rather than timing out on a backup that is still running', async () => {
    // The answer only means something once the archive has been written and read back. A desktop
    // that gave up first would report a working backup as failed and teach the operator to
    // distrust the screen.
    const api = Fastify();
    login(api, 'b'.repeat(64));
    api.post('/api/v1/backups', async (_, reply) => { await new Promise((tick) => setTimeout(tick, 150)); reply.code(201); return record; });
    const { client, close } = await signedIn(api);
    try {
      const started = Date.now();
      expect((await client.createBackup({ kind: 'DATABASE' })).ok).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    } finally { await close(); }
  });
});

describe('a suggested file name', () => {
  it('keeps the plain name the server asked for', () => {
    expect(attachmentName('attachment; filename="BCIS-collections-2026-10-01.csv"', 'COLLECTIONS', 'CSV')).toBe('BCIS-collections-2026-10-01.csv');
  });

  it('discards anything that could steer the save somewhere else', () => {
    // A header is attacker-influenced input that ends up joined to a folder.
    expect(attachmentName('attachment; filename="../../etc/passwd"', 'REVENUE', 'PDF')).toBe('revenue.pdf');
    expect(attachmentName('attachment; filename="C:\\\\Windows\\\\evil.dll"', 'REVENUE', 'PDF')).toBe('revenue.pdf');
    expect(attachmentName('attachment; filename="a/b/c.csv"', 'REVENUE', 'CSV')).toBe('revenue.csv');
    expect(attachmentName('attachment; filename="with null.pdf"', 'REVENUE', 'PDF')).toBe('revenue.pdf');
    expect(attachmentName('attachment; filename=""', 'REVENUE', 'XLSX')).toBe('revenue.xlsx');
    expect(attachmentName(null, 'AR_AGING', 'PDF')).toBe('ar-aging.pdf');
    expect(attachmentName('attachment; filename=', 'REVENUE', 'PDF')).toBe('revenue.pdf');
  });

  it('refuses a name too long for a path', () => {
    expect(attachmentName(`attachment; filename="${'x'.repeat(200)}.pdf"`, 'REVENUE', 'PDF')).toBe('revenue.pdf');
  });
});
