import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { getSystemStatus, parseApiUrl } from '../../source/desktop/main/api-client';

describe('desktop API boundary', () => {
  it('accepts the documented health response from a real HTTP server', async () => {
    const server = Fastify();
    server.get('/api/v1/system/status', () => ({ status: 'ready', database: 'connected', service: 'bcis-api', version: '0.1.0' }));
    const url = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      expect(await getSystemStatus(url)).toMatchObject({ kind: 'status', data: { status: 'ready' } });
    } finally { await server.close(); }
  });

  it('preserves degraded readiness instead of treating HTTP 503 as an unreachable API', async () => {
    const server = Fastify();
    server.get('/api/v1/system/status', (_, reply) => reply.code(503).send({ status: 'degraded', database: 'unavailable', service: 'bcis-api', version: '0.1.0' }));
    const url = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      expect(await getSystemStatus(url)).toMatchObject({ kind: 'status', data: { status: 'degraded' } });
    } finally { await server.close(); }
  });

  it.each([
    { status: 'ready', database: 'unavailable', service: 'bcis-api', version: '0.1.0' },
    { password: 'private-value' },
  ])('rejects malformed or inconsistent server responses', async (body) => {
    const server = Fastify();
    server.get('/api/v1/system/status', () => body);
    const url = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      const result = await getSystemStatus(url);
      expect(result).toMatchObject({ kind: 'unavailable' });
      expect(JSON.stringify(result)).not.toContain('private-value');
    } finally { await server.close(); }
  });

  it('returns a safe result when the server disconnects', async () => {
    const server = Fastify();
    const url = await server.listen({ host: '127.0.0.1', port: 0 });
    await server.close();
    expect(await getSystemStatus(url)).toMatchObject({ kind: 'unavailable' });
  });

  it.each(['file:///etc/passwd', 'http://user:secret@localhost:3100', 'http://localhost:3100/path', 'http://localhost:3100?token=secret'])('rejects an unsafe API origin: %s', (url) => {
    expect(() => parseApiUrl(url)).toThrow();
  });
});
