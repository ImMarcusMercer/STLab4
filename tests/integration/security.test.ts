import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../source/api/app';
import { AuthService } from '../../source/api/auth/service';
import { seedSecurity } from '../../database/seed-security';
import { createTestDatabase } from '../helpers/database';

/**
 * Phase 9: what the API writes to its log, proved against the real database rather than by
 * reading the configuration.
 *
 * The unit suite proves the redaction rules and the logger options. This suite proves the
 * consequence: a sign-in, a refused sign-in, an unauthorised call and a forbidden call are
 * each visible in the log as a named event, and nothing that identifies a person or a
 * credential - the password, the issued token, the token digest, the connection string - is
 * in any line.
 */
const password = 'Synthetic-Security-Password-123!';
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let lines: string[];
let app: ReturnType<typeof buildApp>;
let owner = '';
let viewer = '';
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const events = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
const withEvent = (name: string) => events().filter((record) => record.event === name);
const text = () => lines.join('');

beforeAll(async () => {
  database = await createTestDatabase();
  await seedSecurity(database.pool, { username: 'owner', displayName: 'Security Owner', password });
  const auth = new AuthService(database.pool);
  owner = (await auth.login('owner', password)).token;
  await auth.createUser(owner, { username: 'viewer', displayName: 'Read Only', password, roles: ['VIEWER'] });
  viewer = (await auth.login('viewer', password)).token;
  lines = [];
  app = buildApp({
    checkDatabase: async () => undefined,
    auth,
    logLevel: 'info',
    logStream: { write: (line: string) => { lines.push(line); } },
  });
});
afterAll(async () => { await app?.close(); await database?.close(); });

describe('structured logging in the running API', () => {
  it('writes one JSON object per line, each naming the service and carrying a timestamp', async () => {
    lines = [];
    await app.inject({ url: '/api/v1/system/status' });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(record.service).toBe('bcis-api');
      expect(typeof record.level).toBe('number');
      expect(typeof record.time).toBe('string');
    }
  });

  it('records a sign-in as a named event without the password or the issued token', async () => {
    lines = [];
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'owner', password } });
    expect(response.statusCode).toBe(200);
    const token = (response.json() as { token: string }).token;
    const event = withEvent('auth.login.succeeded')[0] as Record<string, unknown>;
    expect(event).toMatchObject({ level: 30, username: 'owner' });
    expect(event.reqId).toEqual(expect.any(String));
    expect(text()).not.toContain(password);
    expect(text()).not.toContain(token);
  });

  it('records a refused sign-in with the username and the reason, and nothing more', async () => {
    lines = [];
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'owner', password: 'Wrong-Password-123!' } });
    expect(response.statusCode).toBe(401);
    const event = withEvent('auth.login.failed')[0] as Record<string, unknown>;
    expect(event).toMatchObject({ level: 40, username: 'owner', code: 'INVALID_CREDENTIALS' });
    expect(text()).not.toContain('Wrong-Password-123!');
  });

  it('records an unauthenticated and a forbidden call as separate security events', async () => {
    lines = [];
    const anonymous = await app.inject({ url: '/api/v1/receivables/summary' });
    expect(anonymous.statusCode).toBe(401);
    const forbidden = await app.inject({ url: '/api/v1/receivables/summary', headers: bearer(viewer) });
    expect(forbidden.statusCode).toBe(403);
    expect(withEvent('security.unauthenticated')[0]).toMatchObject({ level: 40, path: '/api/v1/receivables/summary' });
    expect(withEvent('security.permission_denied')[0]).toMatchObject({ level: 40, path: '/api/v1/receivables/summary' });
    expect(text()).not.toContain(viewer);
  });

  it('never writes the bearer token a successful call arrived with', async () => {
    lines = [];
    const response = await app.inject({ url: '/api/v1/receivables/summary', headers: bearer(owner) });
    expect(response.statusCode).toBe(200);
    expect(text()).toContain('/api/v1/receivables/summary');
    expect(text()).not.toContain(owner);
  });

  it('never writes the stored session digest either', async () => {
    const digest = (await database.pool.query<{ token_hash: string }>('SELECT token_hash FROM sessions ORDER BY created_at LIMIT 1')).rows[0]?.token_hash ?? '';
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(text()).not.toContain(digest);
  });

  it('keeps the connection string out of a readiness failure', async () => {
    lines = [];
    // The driver quotes the connection string it failed on, and that string carries the
    // pool password, so the readiness failure is the realistic place for a leak.
    const degraded = buildApp({
      checkDatabase: async () => { throw new Error(`connect ECONNREFUSED ${database.url}`); },
      logLevel: 'info',
      logStream: { write: (line: string) => { lines.push(line); } },
    });
    try {
      const response = await degraded.inject('/api/v1/system/status');
      expect(response.statusCode).toBe(503);
    } finally { await degraded.close(); }
    const passwordInUrl = decodeURIComponent(new URL(database.url).password);
    expect(passwordInUrl).not.toBe('');
    expect(text()).toContain('[redacted]');
    expect(text()).not.toContain(passwordInUrl);
    // The refusal itself is still reported, so the log says what happened.
    expect(withEvent('database_readiness_failed')).toHaveLength(1);
  });

  it('answers every request with headers that stop it being sniffed, framed or referred', async () => {
    const response = await app.inject('/api/v1/system/status');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});