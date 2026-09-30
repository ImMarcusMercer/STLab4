import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../source/api/app';
import { AuthService } from '../../source/api/auth/service';
import { seedSecurity } from '../../database/seed-security';
import { createTestDatabase } from '../helpers/database';
import { tokenDigest } from '../../source/api/auth/passwords';

const password = 'Synthetic-Test-Password-123!';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof buildApp>;
let ip = 1;
async function login(username = 'owner', suppliedPassword = password) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: suppliedPassword }, remoteAddress: `127.0.0.${++ip}` });
  expect(response.statusCode).toBe(200);
  return response.json() as { token: string; user: { id: string; permissions: string[] } };
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  database = await createTestDatabase();
  await seedSecurity(database.pool, { username: 'owner', displayName: 'Test Owner', password });
  app = buildApp({ checkDatabase: async () => undefined, auth: new AuthService(database.pool) });
});
afterAll(async () => { await app?.close(); await database?.close(); });

describe('real PostgreSQL authentication and RBAC', () => {
  it('seeds all roles and preserves existing passwords on repeat seed', async () => {
    const before = await database.pool.query('SELECT password_hash FROM users WHERE username=$1', ['owner']);
    expect(before.rows).toHaveLength(1);
    await seedSecurity(database.pool, { username: 'owner', displayName: 'Ignored', password: 'Different-Password-123!' });
    expect((await database.pool.query('SELECT password_hash FROM users WHERE username=$1', ['owner'])).rows).toEqual(before.rows);
    expect((await database.pool.query('SELECT * FROM roles')).rowCount).toBe(7);
  });
  it('issues opaque sessions but exposes no password or token hash in user responses', async () => {
    const result = await login();
    expect(result.token).toMatch(/^[a-f0-9]{64}$/);
    const stored = await database.pool.query('SELECT token_hash FROM sessions WHERE token_hash=$1', [tokenDigest(result.token)]);
    expect(stored.rowCount).toBe(1);
    const me = await app.inject({ url: '/api/v1/auth/me', headers: bearer(result.token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().permissions).toContain('user.manage');
    expect(me.body).not.toMatch(/password|token_hash|scrypt/);
  });
  it('rejects missing and invalid sessions', async () => {
    expect((await app.inject('/api/v1/auth/me')).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/admin/users', headers: bearer('invalid') })).statusCode).toBe(401);
  });
  it('uses the same error for an unknown username and wrong password; validates payloads', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'owner', password: 'incorrect' }, remoteAddress: '127.0.1.1' });
    const missing = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'missing', password: 'incorrect' }, remoteAddress: '127.0.1.2' });
    expect(wrong.statusCode).toBe(401); expect(missing.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe(missing.json().error.message);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'owner', password, roles: ['OWNER'] } })).statusCode).toBe(422);
  });
  it('AT-10: cashier cannot list/create users even through direct HTTP', async () => {
    const owner = await login();
    const create = await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: bearer(owner.token), payload: { username: 'cashier', displayName: 'Test Cashier', password, roles: ['CASHIER'] } });
    expect(create.statusCode).toBe(201);
    const cashier = await login('cashier');
    expect(cashier.user.permissions).not.toContain('user.manage');
    expect((await app.inject({ url: '/api/v1/admin/users', headers: bearer(cashier.token) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: bearer(cashier.token), payload: { username: 'attacker', displayName: 'Attacker', password, roles: ['OWNER'] } })).statusCode).toBe(403);
    expect((await database.pool.query('SELECT id FROM users WHERE username=$1', ['attacker'])).rowCount).toBe(0);
  });
  it('revokes sessions on lock and logout and rejects expired sessions', async () => {
    for (const action of ['lock', 'logout']) {
      const session = await login();
      expect((await app.inject({ method: 'POST', url: `/api/v1/auth/${action}`, headers: bearer(session.token) })).statusCode).toBe(204);
      expect((await app.inject({ url: '/api/v1/auth/me', headers: bearer(session.token) })).statusCode).toBe(401);
    }
    const session = await login();
    await database.pool.query('UPDATE sessions SET expires_at=now()-interval \'1 second\' WHERE token_hash=$1', [tokenDigest(session.token)]);
    expect((await app.inject({ url: '/api/v1/auth/me', headers: bearer(session.token) })).statusCode).toBe(401);
  });
  it('validates user creation, blocks duplicates and paginates owner results', async () => {
    const owner = await login();
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: bearer(owner.token), payload: { username: 'owner', displayName: 'Duplicate', password, roles: ['VIEWER'] } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: bearer(owner.token), payload: { username: 'short', displayName: 'Bad', password: 'short', roles: ['OWNER'] } })).statusCode).toBe(422);
    const users = await app.inject({ url: '/api/v1/admin/users?page=1&perPage=1', headers: bearer(owner.token) });
    expect(users.statusCode).toBe(200); expect(users.json().items).toHaveLength(1);
    expect(users.body).not.toMatch(/password|scrypt/);
    expect((await app.inject({ url: '/api/v1/admin/users?page=-1', headers: bearer(owner.token) })).statusCode).toBe(422);
  });
  it('account deactivation revokes existing sessions and blocks new login', async () => {
    const owner = await login();
    const created = await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: bearer(owner.token), payload: { username: 'temporary', displayName: 'Temporary', password, roles: ['VIEWER'] } });
    expect(created.statusCode).toBe(201);
    const viewer = await login('temporary');
    const change = await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${viewer.user.id}`, headers: bearer(owner.token), payload: { active: false } });
    expect(change.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/auth/me', headers: bearer(viewer.token) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'temporary', password }, remoteAddress: '127.0.2.1' })).statusCode).toBe(401);
  });
  it('protects the last active owner and audits user mutations without secrets', async () => {
    const owner = await login();
    const response = await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${owner.user.id}`, headers: bearer(owner.token), payload: { roles: ['VIEWER'] } });
    expect(response.statusCode).toBe(409);
    const audit = await database.pool.query('SELECT action, details FROM audit_logs');
    expect(audit.rows.some((row) => row.action === 'user.create')).toBe(true);
    expect(JSON.stringify(audit.rows)).not.toContain(password);
  });
  it('throttles repeated login attempts from one client', async () => {
    let status = 0;
    for (let i = 0; i < 11; i++) {
      status = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'nobody', password: 'wrong' }, remoteAddress: '127.0.9.9' })).statusCode;
    }
    expect(status).toBe(429);
  });
  it('role and password changes revoke sessions and take effect at the server', async () => {
    const owner = await login();
    const created = await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: bearer(owner.token), payload: { username: 'changing', displayName: 'Changing', password, roles: ['CASHIER'] } });
    expect(created.statusCode).toBe(201);
    const previous = await login('changing');
    const changedPassword = 'Changed-Synthetic-Password-123!';
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${previous.user.id}`, headers: bearer(owner.token), payload: { roles: ['VIEWER'], password: changedPassword } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/auth/me', headers: bearer(previous.token) })).statusCode).toBe(401);
    const next = await login('changing', changedPassword);
    expect(next.user.permissions).not.toContain('payment.create');
    expect(next.user.permissions).toContain('report.view');
  });
  it('concurrent owner removals cannot leave zero active owners', async () => {
    const owner = await login();
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: bearer(owner.token), payload: { username: 'second-owner', displayName: 'Second Owner', password, roles: ['OWNER'] } })).statusCode).toBe(201);
    const second = await login('second-owner');
    const results = await Promise.all([owner, second].map((session) => app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${session.user.id}`, headers: bearer(session.token), payload: { active: false } })));
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect((await database.pool.query("SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.active AND r.role_code='OWNER'")).rowCount).toBe(1);
  });
});
