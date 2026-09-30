import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { AuthClient } from '../../source/desktop/main/auth-client';

const actor = { id: '11111111-1111-4111-8111-111111111111', username: 'owner', displayName: 'Owner', active: true, roles: ['OWNER'], permissions: ['user.manage'] };
describe('desktop session boundary', () => {
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
