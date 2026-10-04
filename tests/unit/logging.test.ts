import { describe, expect, it } from 'vitest';
import { buildApp } from '../../source/api/app';
import { REDACTION, SECRET_PATHS, buildLoggerOptions, scrubSecrets } from '../../source/api/logging';

/** Collects the raw log lines a logger writes, so a test reads what an operator would. */
function capture() {
  const lines: string[] = [];
  return { lines, stream: { write: (line: string) => { lines.push(line); } } };
}
const records = (lines: string[]) => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

describe('log redaction', () => {
  it('removes the password from a connection string in free text', () => {
    const scrubbed = scrubSecrets('connect ECONNREFUSED postgresql://bcis_local:hunter2@127.0.0.1:55432/bcis');
    expect(scrubbed).toBe(`connect ECONNREFUSED postgresql://bcis_local:${REDACTION}@127.0.0.1:55432/bcis`);
    expect(scrubbed).not.toContain('hunter2');
  });

  it('removes credentials written as assignments', () => {
    expect(scrubSecrets('pg_restore --dbname=bcis password=hunter2 token=abc123')).toBe(
      `pg_restore --dbname=bcis password=${REDACTION} token=${REDACTION}`,
    );
    expect(scrubSecrets('PGPASSWORD: hunter2')).toBe(`PGPASSWORD: ${REDACTION}`);
  });

  it('leaves an ordinary message readable', () => {
    expect(scrubSecrets('relation "subscribers" does not exist')).toBe('relation "subscribers" does not exist');
  });

  it('covers the header and body paths a secret could arrive in', () => {
    expect(SECRET_PATHS).toContain('req.headers.authorization');
    expect(SECRET_PATHS).toContain('password');
    expect(SECRET_PATHS).toContain('body.password');
    expect(SECRET_PATHS).toContain('*.base64');
    expect(SECRET_PATHS).toContain('DATABASE_URL');
  });
});

describe('logger configuration', () => {
  it('names the service, uses an ISO timestamp and scrubs an error message', () => {
    const options = buildLoggerOptions('info');
    expect(options.base).toEqual({ service: 'bcis-api' });
    const timestamp = (options.timestamp as () => string)();
    expect(timestamp).toMatch(/^,"time":"\d{4}-\d{2}-\d{2}T[\d:.]+Z"$/);
    const serializeError = options.serializers?.err as unknown as (error: Record<string, unknown>) => Record<string, unknown>;
    const serialized = serializeError({ name: 'Error', code: 'ECONNREFUSED', message: 'postgresql://bcis_local:hunter2@127.0.0.1/bcis', stack: 'Error: x' });
    expect(serialized.message).toBe(`postgresql://bcis_local:${REDACTION}@127.0.0.1/bcis`);
    expect(serialized.stack).toBe('Error: x');
  });

  it('keeps the request fields an operator needs and drops every other header', () => {
    const options = buildLoggerOptions('info');
    const serializeRequest = options.serializers?.req as unknown as (request: Record<string, unknown>) => Record<string, unknown>;
    const serialized = serializeRequest({
      method: 'GET', url: '/api/v1/subscribers', id: 'req-1', ip: '127.0.0.1',
      headers: { 'user-agent': 'bcis-desktop/0.1', authorization: 'Bearer abc', cookie: 'session=1' },
    });
    expect(serialized).toEqual({ method: 'GET', url: '/api/v1/subscribers', reqId: 'req-1', remoteAddress: '127.0.0.1', userAgent: 'bcis-desktop/0.1' });
    expect(JSON.stringify(serialized)).not.toContain('Bearer');
    expect(JSON.stringify(serialized)).not.toContain('cookie');
  });
});

describe('logged requests', () => {
  it('writes one JSON line per request, tagged with the service and the request id', async () => {
    const { lines, stream } = capture();
    const app = buildApp({ checkDatabase: async () => undefined, logLevel: 'info', logStream: stream });
    try {
      const response = await app.inject({ url: '/health', headers: { 'x-request-note': 'ignored' } });
      expect(response.statusCode).toBe(200);
      const written = records(lines);
      expect(written.length).toBeGreaterThan(0);
      for (const record of written) {
        expect(record.service).toBe('bcis-api');
        expect(typeof record.time).toBe('string');
        expect(typeof record.level).toBe('number');
      }
      const completed = written.find((record) => record.msg === 'request completed') as Record<string, unknown> | undefined;
      const incoming = written.find((record) => record.msg === 'incoming request') as Record<string, unknown> | undefined;
      expect((completed?.res as Record<string, unknown>).statusCode).toBe(200);
      // Both lines carry the same id, so one request can be followed through the log.
      expect(completed?.reqId).toBe(incoming?.reqId);
      expect((incoming?.req as Record<string, unknown>).url).toBe('/health');
    } finally { await app.close(); }
  });

  it('never writes the bearer token a request arrived with', async () => {
    const { lines, stream } = capture();
    const app = buildApp({ checkDatabase: async () => undefined, logLevel: 'info', logStream: stream });
    try {
      await app.inject({ url: '/api/v1/system/status', headers: { authorization: 'Bearer ' + 'f'.repeat(64) } });
      expect(lines.join('')).not.toContain('f'.repeat(64));
      // The token is not in a line, but the request that carried it is still identifiable.
      expect(lines.some((line) => line.includes('/api/v1/system/status'))).toBe(true);
    } finally { await app.close(); }
  });

  it('scrubs a secret a caller logs explicitly', async () => {
    const { lines, stream } = capture();
    const app = buildApp({ checkDatabase: async () => undefined, logLevel: 'info', logStream: stream });
    try {
      app.log.info({ password: 'Synthetic-Password-123!', connectionString: 'postgresql://u:p@h/db' }, 'direct call');
      const direct = records(lines).find((record) => record.msg === 'direct call') as Record<string, unknown>;
      expect(direct.password).toBe(REDACTION);
      // A whole value on a listed path is replaced rather than partially scrubbed, which is stronger.
      expect(direct.connectionString).toBe(REDACTION);
    } finally { await app.close(); }
  });
});

describe('response hardening', () => {
  it('answers with headers that stop a response being sniffed, framed or referred', async () => {
    const app = buildApp({ checkDatabase: async () => undefined, logLevel: 'silent' });
    try {
      for (const url of ['/health', '/api/v1/system/status', '/api/v1/nothing-here']) {
        const response = await app.inject(url);
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['x-frame-options']).toBe('DENY');
        expect(response.headers['referrer-policy']).toBe('no-referrer');
      }
    } finally { await app.close(); }
  });

  it('keeps the readiness answer out of any cache', async () => {
    const app = buildApp({ checkDatabase: async () => undefined, logLevel: 'silent' });
    try {
      expect((await app.inject('/api/v1/system/status')).headers['cache-control']).toBe('no-store');
    } finally { await app.close(); }
  });
});