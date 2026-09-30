import { describe, expect, it } from 'vitest';
import { localDatabaseUrl } from '../../scripts/local-database-config.mjs';

describe('isolated local database setup', () => {
  const origin = 'postgresql://bcis_local:synthetic-test-password@127.0.0.1:55432/bcis';
  it('accepts only the dedicated connection', () => {
    expect(localDatabaseUrl(origin).port).toBe('55432');
  });
  it.each(['?host=other-server&port=5432&user=other_user', '?dbname=another', '#fragment'])('rejects hidden connection overrides %s', (suffix) => {
    expect(() => localDatabaseUrl(origin + suffix)).toThrow();
  });
  it('rejects an unrelated database', () => {
    expect(() => localDatabaseUrl('postgresql://user:password@localhost:5432/student')).toThrow();
  });
});
