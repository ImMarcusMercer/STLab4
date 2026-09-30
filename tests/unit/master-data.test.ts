import { it, expect } from 'vitest';
import { parseCentavos, decimalMoney, recordSchema } from '../../source/shared/master-data';
it('parses UI money exactly and rejects excessive precision, exponents and overflow', () => {
  expect(parseCentavos('999.01')).toBe(99901); expect(parseCentavos('0.10')).toBe(10);
  for (const value of ['1.001','1e3','-1','10000000','']) expect(parseCentavos(value)).toBeNull();
  expect(decimalMoney(99901)).toBe('999.01');
});
it('accepts server record metadata without weakening strict plan input validation', () => {
  expect(recordSchema('areas').safeParse({ id: '11111111-1111-4111-8111-111111111111', version: 1, createdAt: '2026-09-28', code: 'AREA1', name: 'Central', description: '', active: true }).success).toBe(true);
});
