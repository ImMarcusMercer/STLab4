import { describe, expect, it } from 'vitest';
import { buildApp } from '../../source/api/app';

describe('API health and readiness', () => {
  it('keeps liveness healthy when the database is unavailable', async () => {
    const app = buildApp({ checkDatabase: async () => { throw new Error('private connection credentials'); } });
    try {
      const live = await app.inject('/health');
      expect(live.statusCode).toBe(200);
      expect(live.json()).toEqual({ status: 'ok', service: 'bcis-api' });
      const ready = await app.inject('/api/v1/system/status');
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({ status: 'degraded', database: 'unavailable' });
      expect(ready.body).not.toContain('private');
    } finally { await app.close(); }
  });

  it('reports ready only after the database and migration check succeeds', async () => {
    const app = buildApp({ checkDatabase: async () => undefined });
    try {
      const response = await app.inject('/api/v1/system/status');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ready', database: 'connected', service: 'bcis-api' });
    } finally { await app.close(); }
  });

  it('returns safe structured errors for unknown routes', async () => {
    const app = buildApp({ checkDatabase: async () => undefined });
    try {
      const response = await app.inject('/api/v1/subscribers');
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND', requestId: expect.any(String) } });
    } finally { await app.close(); }
  });
});
