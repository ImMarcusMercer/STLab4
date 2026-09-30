import { describe, expect, it } from 'vitest';
import { readConfig } from '../../source/api/config';

describe('server configuration', () => {
  const base = { DATABASE_URL: 'postgresql://user:password@127.0.0.1:55432/bcis' };
  it('defaults to a separate loopback API port', () => {
    expect(readConfig(base)).toMatchObject({ HOST: '127.0.0.1', PORT: 3100 });
  });
  it.each(['0', '65536', 'abc', '1.5'])('rejects invalid port %s', (PORT) => {
    expect(() => readConfig({ ...base, PORT })).toThrow();
  });
  it('requires a PostgreSQL connection string', () => {
    expect(() => readConfig({ DATABASE_URL: 'sqlite:local.db' })).toThrow();
    expect(() => readConfig({})).toThrow();
  });
});
