import { it, expect } from 'vitest';
import {
  RecordPaymentInput, advanceBalance, formatReceiptNumber, planAllocation, proofExtension, receiptNumberYear, type OpenInvoice,
} from '../../source/shared/payments';

const invoice = (id: string, balanceCentavos: number, dueDate = '2026-09-15', issueDate = '2026-09-01'): OpenInvoice => ({ id, balanceCentavos, dueDate, issueDate });

it('applies a payment to the oldest due date first (AT-04)', () => {
  const plan = planAllocation([invoice('newer', 50000, '2026-10-15'), invoice('oldest', 30000, '2026-07-15'), invoice('middle', 20000, '2026-08-15')], 40000);
  expect(plan.allocations).toEqual([
    { invoiceId: 'oldest', amountCentavos: 30000 },
    { invoiceId: 'middle', amountCentavos: 10000 },
  ]);
  expect(plan.appliedCentavos).toBe(40000);
  expect(plan.advanceCentavos).toBe(0);
});

it('orders equal due dates by issue date and then by identifier, so the result is repeatable', () => {
  const plan = planAllocation([invoice('b', 10000, '2026-09-15', '2026-09-01'), invoice('a', 10000, '2026-09-15', '2026-09-01'), invoice('c', 10000, '2026-09-15', '2026-08-01')], 20000);
  expect(plan.allocations.map(step => step.invoiceId)).toEqual(['c', 'a']);
});

it('settles several invoices exactly and stops at the balance of each (AT-01)', () => {
  const plan = planAllocation([invoice('first', 199900), invoice('second', 149900)], 300000);
  expect(plan.allocations).toEqual([
    { invoiceId: 'first', amountCentavos: 199900 },
    { invoiceId: 'second', amountCentavos: 100100 },
  ]);
  expect(plan.appliedCentavos).toBe(300000);
  expect(plan.advanceCentavos).toBe(0);
});

it('holds everything as an advance credit when nothing is outstanding (AT-03)', () => {
  const plan = planAllocation([], 50000);
  expect(plan.allocations).toEqual([]);
  expect(plan.appliedCentavos).toBe(0);
  expect(plan.advanceCentavos).toBe(50000);
});

it('keeps the excess of an overpayment as a credit after settling the oldest invoice (AT-02, AT-03)', () => {
  const plan = planAllocation([invoice('only', 199900)], 250000);
  expect(plan.allocations).toEqual([{ invoiceId: 'only', amountCentavos: 199900 }]);
  expect(plan.appliedCentavos).toBe(199900);
  expect(plan.advanceCentavos).toBe(50100);
});

it('never allocates to a settled invoice and never allocates a zero amount', () => {
  const plan = planAllocation([invoice('settled', 0), invoice('open', 1000)], 500);
  expect(plan.allocations).toEqual([{ invoiceId: 'open', amountCentavos: 500 }]);
  expect(planAllocation([invoice('open', 1000)], 0)).toEqual({ allocations: [], appliedCentavos: 0, advanceCentavos: 0 });
});

it('refuses a negative amount instead of producing money', () => {
  expect(() => planAllocation([invoice('open', 1000)], -1)).toThrow(RangeError);
  expect(() => planAllocation([invoice('open', 1000)], 12.5)).toThrow(RangeError);
});

it('reports the credit a subscriber still holds', () => {
  expect(advanceBalance([{ amountCentavos: 199900, appliedCentavos: 199900 }, { amountCentavos: 50000, appliedCentavos: 20000 }])).toBe(30000);
  expect(advanceBalance([])).toBe(0);
});

it('numbers receipts per year like invoices, and never reuses a number', () => {
  expect(formatReceiptNumber(2026, 1001)).toBe('RCT-2026-1001');
  expect(formatReceiptNumber(2027, 1042)).toBe('RCT-2027-1042');
  expect(receiptNumberYear('RCT-2026-1001')).toBe(2026);
});

it('accepts a GCash payment only with a reference and a receipt, and a cash payment without a reference', () => {
  const gcash = { subscriberId: '11111111-1111-4111-8111-111111111111', method: 'GCASH', amountCentavos: 1000, receivedOn: '2026-09-30', proof: { fileName: 'gcash.png', mimeType: 'image/png', base64: 'aGVsbG8=' } };
  expect(RecordPaymentInput.safeParse({ ...gcash, referenceNumber: 'GC-123456' }).success).toBe(true);
  expect(RecordPaymentInput.safeParse({ ...gcash }).success).toBe(false);
  expect(RecordPaymentInput.safeParse({ ...gcash, referenceNumber: 'GC-123456', proof: undefined }).success).toBe(false);
  expect(RecordPaymentInput.safeParse({ ...gcash, referenceNumber: 'GC 123456' }).success).toBe(false);
  const cash = { subscriberId: gcash.subscriberId, method: 'CASH', amountCentavos: 1000, receivedOn: '2026-09-30' };
  expect(RecordPaymentInput.safeParse(cash).success).toBe(true);
  expect(RecordPaymentInput.safeParse({ ...cash, referenceNumber: 'GC-123456' }).success).toBe(false);
  expect(RecordPaymentInput.safeParse({ ...cash, amountCentavos: 0 }).success).toBe(false);
  expect(RecordPaymentInput.safeParse({ ...cash, amountCentavos: 99.5 }).success).toBe(false);
});

it('keeps the stored proof name on an extension the type controls', () => {
  expect(proofExtension('image/png')).toBe('.png');
  expect(proofExtension('image/jpeg')).toBe('.jpg');
  expect(proofExtension('application/pdf')).toBe('.pdf');
});
