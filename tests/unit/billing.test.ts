import { it, expect } from 'vitest';
import {
  billingDates, clampToMonth, cycleBounds, daysBetween, decimalMoney, deriveStatus, formatInvoiceNumber, invoiceNumberYear,
  InvoiceSchema, lastDayOfMonth, lineAmount, parseCentavos, periodLabel, periodOf, shiftPeriod, sumLines, verifyRunningBalance, type LedgerEvent,
} from '../../source/shared/billing';

const adjustmentFixture = (adjustmentCentavos: number) => ({
  id: '11111111-1111-4111-8111-111111111111', invoiceNumber: 'INV-2026-1001', status: 'UNPAID', source: 'CYCLE',
  periodLabel: 'September 2026', issueDate: '2026-09-01', dueDate: '2026-09-15',
  subtotalCentavos: 199900, adjustmentCentavos, totalCentavos: 199900 + adjustmentCentavos, paidCentavos: 0, balanceCentavos: 199900 + adjustmentCentavos,
  notes: '', voidReason: '', createdAt: '2026-09-01T00:00:00.000Z', finalizedAt: '2026-09-01T00:00:00.000Z', voidedAt: null,
  subscriberId: '22222222-2222-4222-8222-222222222222', subscriberCode: 'SUB001', subscriberName: 'Sample Subscriber',
  serviceAccountId: '33333333-3333-4333-8333-333333333333', serviceCode: 'SVC001', serviceAddress: 'Malaybalay',
  cycleCode: '2026-09', items: [], adjustments: [],
});

it('resolves calendar boundaries and clamps billing days to real month lengths', () => {
  expect(cycleBounds('2026-09')).toEqual({ periodStart: '2026-09-01', periodEnd: '2026-09-30' });
  expect(cycleBounds('2026-02')).toEqual({ periodStart: '2026-02-01', periodEnd: '2026-02-28' });
  expect(cycleBounds('2024-02')).toEqual({ periodStart: '2024-02-01', periodEnd: '2024-02-29' });
  expect(lastDayOfMonth(2026, 4)).toBe(30);
  expect(clampToMonth('2026-02-01', 31)).toBe('2026-02-28');
  expect(clampToMonth('2024-02-01', 31)).toBe('2024-02-29');
  expect(clampToMonth('2026-04-01', 31)).toBe('2026-04-30');
  expect(clampToMonth('2026-09-01', 1)).toBe('2026-09-01');
  expect(shiftPeriod('2026-12', 1)).toBe('2027-01');
  expect(shiftPeriod('2026-01', -1)).toBe('2025-12');
  expect(periodOf('2026-09-28')).toBe('2026-09');
  expect(periodLabel('2026-09')).toBe('September 2026');
  expect(daysBetween('2026-09-01', '2026-10-01')).toBe(30);
});

it('places the due date on or after the issue date and clamps both to the calendar', () => {
  expect(billingDates('2026-09-01', 1, 15)).toEqual({ issueDate: '2026-09-01', dueDate: '2026-09-15' });
  // A due day before the billing day falls in the following month.
  expect(billingDates('2026-09-01', 25, 5)).toEqual({ issueDate: '2026-09-25', dueDate: '2026-10-05' });
  // February clamps 31 to the 28th on both dates, so the invoice is never due before it is issued.
  expect(billingDates('2026-02-01', 31, 31)).toEqual({ issueDate: '2026-02-28', dueDate: '2026-02-28' });
  expect(billingDates('2026-02-01', 31, 20)).toEqual({ issueDate: '2026-02-28', dueDate: '2026-03-20' });
  for (let month = 1; month <= 12; month++) {
    const start = `2026-${String(month).padStart(2, '0')}-01`;
    for (const billingDay of [1, 15, 28, 29, 30, 31]) {
      for (const dueDay of [1, 15, 28, 29, 30, 31]) {
        const dates = billingDates(start, billingDay, dueDay);
        expect(dates.issueDate.slice(0, 7)).toBe(start.slice(0, 7));
        expect(dates.dueDate >= dates.issueDate).toBe(true);
      }
    }
  }
});

it('keeps every line amount equal to quantity times unit price with a type-driven sign', () => {
  expect(lineAmount({ itemType: 'SUBSCRIPTION', quantity: 1, unitPriceCentavos: 99900 })).toBe(99900);
  expect(lineAmount({ itemType: 'PENALTY', quantity: 3, unitPriceCentavos: 2500 })).toBe(7500);
  expect(lineAmount({ itemType: 'DISCOUNT', quantity: 1, unitPriceCentavos: 5000 })).toBe(-5000);
  expect(lineAmount({ itemType: 'ADJUSTMENT', quantity: 1, unitPriceCentavos: 2500, amountCentavos: -2500 })).toBe(-2500);
  expect(lineAmount({ itemType: 'ADJUSTMENT', quantity: 1, unitPriceCentavos: 2500, amountCentavos: 2500 })).toBe(2500);
  expect(() => lineAmount({ itemType: 'ADJUSTMENT', quantity: 1, unitPriceCentavos: 2500, amountCentavos: -2400 })).toThrow(RangeError);
  // Only an adjustment line may reverse its own sign.
  expect(() => lineAmount({ itemType: 'SUBSCRIPTION', quantity: 1, unitPriceCentavos: 99900, amountCentavos: -99900 })).toThrow(RangeError);
  expect(() => lineAmount({ itemType: 'DISCOUNT', quantity: 1, unitPriceCentavos: 5000, amountCentavos: 5000 })).toThrow(RangeError);
  expect(() => lineAmount({ itemType: 'SUBSCRIPTION', quantity: 1000, unitPriceCentavos: 999999999 })).toThrow(RangeError);
  // A credit may not exceed the charge it reduces.
  expect(() => sumLines([
    { itemType: 'SUBSCRIPTION', quantity: 1, unitPriceCentavos: 10000 },
    { itemType: 'DISCOUNT', quantity: 1, unitPriceCentavos: 20000 },
  ])).toThrow(RangeError);
  // An invoice of exactly zero is allowed and is treated as settled.
  expect(sumLines([
    { itemType: 'SUBSCRIPTION', quantity: 1, unitPriceCentavos: 10000 },
    { itemType: 'DISCOUNT', quantity: 1, unitPriceCentavos: 10000 },
  ])).toEqual({ subtotalCentavos: 10000, adjustmentCentavos: -10000, totalCentavos: 0 });
});

it('derives the invoice total from its lines and rejects floating-point money text', () => {
  expect(InvoiceSchema.safeParse(adjustmentFixture(-50100)).success).toBe(true);
  expect(sumLines([
    { itemType: 'SUBSCRIPTION', quantity: 1, unitPriceCentavos: 99900 },
    { itemType: 'INSTALLATION', quantity: 1, unitPriceCentavos: 100000 },
    { itemType: 'DISCOUNT', quantity: 1, unitPriceCentavos: 50000 },
    { itemType: 'ADJUSTMENT', quantity: 1, unitPriceCentavos: 100, amountCentavos: -100 },
  ])).toEqual({ subtotalCentavos: 199900, adjustmentCentavos: -50100, totalCentavos: 149800 });
  expect(sumLines([])).toEqual({ subtotalCentavos: 0, adjustmentCentavos: 0, totalCentavos: 0 });
  expect(parseCentavos('999.01')).toBe(99901);
  expect(decimalMoney(149800)).toBe('1498.00');
  expect(decimalMoney(-50100)).toBe('-501.00');
  for (const value of ['1.001', '1e3', '-1', '10000000', '']) expect(parseCentavos(value)).toBeNull();
  // A discount makes the adjustment column negative; the totals stay non-negative.
  expect(InvoiceSchema.safeParse(adjustmentFixture(50100)).success).toBe(true);
  expect(InvoiceSchema.safeParse(adjustmentFixture(-50100)).success).toBe(true);
  expect(InvoiceSchema.safeParse({ ...adjustmentFixture(-50100), balanceCentavos: -1 }).success).toBe(false);
  expect(InvoiceSchema.safeParse({ ...adjustmentFixture(-50100), totalCentavos: 1.5 }).success).toBe(false);
});

it('derives the invoice state from the totals rather than accepting a caller choice', () => {
  const base = { totalCentavos: 99900, paidCentavos: 0, dueDate: '2026-09-15', asOf: '2026-09-20' };
  expect(deriveStatus(base)).toBe('OVERDUE');
  expect(deriveStatus({ ...base, asOf: '2026-09-15' })).toBe('UNPAID');
  expect(deriveStatus({ ...base, paidCentavos: 50000 })).toBe('PARTIALLY_PAID');
  expect(deriveStatus({ ...base, paidCentavos: 99900 })).toBe('PAID');
  expect(deriveStatus({ ...base, paidCentavos: 99900, settledByCredit: true })).toBe('CREDITED');
  expect(deriveStatus({ ...base, voided: true, paidCentavos: 99900 })).toBe('VOID');
  expect(deriveStatus({ ...base, totalCentavos: 0 })).toBe('PAID');
});

it('formats gap-free invoice numbers per year and reads the year back', () => {
  expect(formatInvoiceNumber(2026, 1001)).toBe('INV-2026-1001');
  expect(formatInvoiceNumber(2026, 12345)).toBe('INV-2026-12345');
  expect(invoiceNumberYear('INV-2026-1001')).toBe(2026);
});

it('reproduces the laboratory ledger example and detects a corrupted running balance', () => {
  // 999.00 debit, 500.00 credit, 499.00 credit — the PDF's worked example.
  const entries: LedgerEvent[] = [
    { entryNo: 1, entryDate: '2026-09-01', debitCentavos: 99900, creditCentavos: 0, balanceCentavos: 99900 },
    { entryNo: 2, entryDate: '2026-09-05', debitCentavos: 0, creditCentavos: 50000, balanceCentavos: 49900 },
    { entryNo: 3, entryDate: '2026-09-20', debitCentavos: 0, creditCentavos: 49900, balanceCentavos: 0 },
  ];
  expect(verifyRunningBalance(entries).differences).toEqual([]);
  // Unsorted input reproduces the same order, because the ledger is ordered by (date, entryNo).
  const shuffled = [entries[2]!, entries[0]!, entries[1]!];
  expect(verifyRunningBalance(shuffled).differences).toEqual([]);
  // A back-dated entry shifts every later balance, which is why the API rebuilds the
  // whole subscriber ledger inside the posting transaction instead of appending.
  const backdated: LedgerEvent[] = [...entries, { entryNo: 4, entryDate: '2026-09-02', debitCentavos: 10000, creditCentavos: 0, balanceCentavos: 0 }];
  const rebuilt = verifyRunningBalance(backdated);
  expect(rebuilt.expected.get(4)).toBe(109900);
  expect(rebuilt.expected.get(1)).toBe(99900);
  expect(rebuilt.differences).toEqual([2, 3, 4]);
  expect(verifyRunningBalance([{ ...entries[0]!, balanceCentavos: 1 }]).differences).toEqual([1]);
  expect(verifyRunningBalance([]).expected.size).toBe(0);
});
