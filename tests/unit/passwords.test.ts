import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, tokenDigest } from '../../source/api/auth/passwords';

describe('password and token storage', () => {
  it('salts hashes and verifies only the correct password', async () => {
    const password = 'Synthetic-test-password-123!';
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword('wrong-password', first)).toBe(false);
  });
  it('rejects corrupt hashes safely', async () => {
    expect(await verifyPassword('password', 'broken')).toBe(false);
    expect(await verifyPassword('password', 'scrypt$999999999$8$1$invalid$invalid')).toBe(false);
  });
  it('never stores a bearer token verbatim', () => {
    expect(tokenDigest('synthetic-token')).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenDigest('synthetic-token')).not.toBe(tokenDigest('other-token'));
  });
});
