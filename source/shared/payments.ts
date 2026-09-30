import { z } from 'zod';
import { IsoDate, reason } from './billing';

export const paymentMethodValues = ['CASH', 'GCASH'] as const;
export const paymentStatusValues = ['PENDING', 'POSTED', 'VOID', 'REVERSED'] as const;
export const allocationSourceValues = ['PAYMENT', 'ADVANCE'] as const;

export const PaymentMethod = z.enum(paymentMethodValues);
export type PaymentMethod = z.infer<typeof PaymentMethod>;
export const PaymentStatus = z.enum(paymentStatusValues);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

const money = z.number().int().min(0).max(999999999);
const amount = z.number().int().min(1).max(999999999);
/** GCash references are the duplicate-protection key, so the shape is deliberately narrow. */
const reference = z.string().trim().min(4).max(40).regex(/^[A-Za-z0-9-]+$/, 'Use the GCash reference number with letters, digits or dashes.');
/** Only images and PDF receipts are stored; every other type is refused before it touches the disk. */
export const proofMimeValues = ['image/png', 'image/jpeg', 'application/pdf'] as const;
export const proofByteLimit = 5_242_880;
/** A stored proof is a generated name only, so no path can ever reach the desktop. */
const storedName = z.string().regex(/^[a-f0-9-]{36}\.(png|jpg|pdf)$/, 'Unexpected proof file name.');
/** A name shown to an operator is one path segment: no directory, drive or wildcard in it. */
const displayName = z.string().min(1).max(180).refine(
  (value) => !/[\\/:*?"<>|\p{Cc}]/u.test(value),
  'Use the file name only, without a path.',
);

export const PaymentProofSchema = z.object({
  id: z.uuid(), originalName: displayName, storedName, mimeType: z.enum(proofMimeValues),
  byteSize: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), uploadedAt: z.string(),
});
export type PaymentProof = z.infer<typeof PaymentProofSchema>;

export const PaymentAllocationSchema = z.object({
  id: z.uuid(), invoiceId: z.uuid(), invoiceNumber: z.string().nullable(), amountCentavos: amount,
  source: z.enum(allocationSourceValues), sourcePaymentId: z.uuid().nullable(), createdAt: z.string(),
  reversedAt: z.string().nullable(),
});
export type PaymentAllocation = z.infer<typeof PaymentAllocationSchema>;

export const PaymentSchema = z.object({
  id: z.uuid(), receiptNumber: z.string().nullable(), method: PaymentMethod, status: PaymentStatus,
  amountCentavos: amount, direction: z.enum(['PAYMENT', 'REVERSAL']), receivedOn: IsoDate, referenceNumber: z.string().nullable(),
  notes: z.string(), reason: z.string(), subscriberId: z.uuid(), subscriberCode: z.string(), subscriberName: z.string(),
  appliedCentavos: money, advanceCentavos: money, reversalOfId: z.uuid().nullable(), reversalOfReceipt: z.string().nullable(),
  recordedBy: z.string(), recordedName: z.string(), verifiedBy: z.uuid().nullable(), verifiedName: z.string().nullable(), verifiedAt: z.string().nullable(),
  voidedAt: z.string().nullable(), voidReason: z.string(), proof: PaymentProofSchema.nullable(), createdAt: z.string(),
});
export type Payment = z.infer<typeof PaymentSchema>;

export const PaymentListSchema = z.object({
  items: z.array(PaymentSchema), total: z.number().int(), page: z.number().int(), perPage: z.number().int(),
});
export type PaymentList = z.infer<typeof PaymentListSchema>;

/** One payment with the invoices it settled, so a receipt can be checked against them. */
export const PaymentDetailSchema = PaymentSchema.extend({ allocations: z.array(PaymentAllocationSchema) });
export type PaymentDetail = z.infer<typeof PaymentDetailSchema>;

/** What one payment command did, so the operator sees the allocation result without a second query. */
export const PaymentResultSchema = z.object({
  payment: PaymentSchema, allocatedCentavos: money, advanceCentavos: money,
  touched: z.array(z.object({ invoiceId: z.uuid(), invoiceNumber: z.string().nullable(), appliedCentavos: amount, balanceCentavos: money, status: z.string() })),
});
export type PaymentResult = z.infer<typeof PaymentResultSchema>;

/** Open invoices of one subscriber, ordered the way allocation consumes them. */
export const SubscriberAccountSchema = z.object({
  subscriberId: z.uuid(), subscriberCode: z.string(), subscriberName: z.string(),
  outstandingCentavos: money, advanceCentavos: money, items: z.array(z.object({
    invoiceId: z.uuid(), invoiceNumber: z.string().nullable(), periodLabel: z.string(), dueDate: IsoDate,
    totalCentavos: amount, paidCentavos: money, balanceCentavos: money, status: z.string(),
  })),
});
export type SubscriberAccount = z.infer<typeof SubscriberAccountSchema>;

export const RecordPaymentInput = z.object({
  subscriberId: z.uuid(), method: PaymentMethod, amountCentavos: amount, receivedOn: IsoDate,
  referenceNumber: reference.optional(), notes: z.string().trim().max(500).default(''),
  // A GCash payment is only posted after someone other than the collector confirms the
  // reference, so the proof is mandatory with the command that records it.
  proof: z.object({ fileName: displayName, mimeType: z.enum(proofMimeValues), base64: z.string().min(8).max(7_200_000) }).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.method === 'GCASH' && !value.referenceNumber) ctx.addIssue({ code: 'custom', path: ['referenceNumber'], message: 'A GCash payment needs its reference number.' });
  if (value.method === 'CASH' && value.referenceNumber) ctx.addIssue({ code: 'custom', path: ['referenceNumber'], message: 'A cash payment has no reference number.' });
  if (value.method === 'GCASH' && !value.proof) ctx.addIssue({ code: 'custom', path: ['proof'], message: 'Attach the GCash receipt image before recording the payment.' });
});
export type RecordPaymentInput = z.infer<typeof RecordPaymentInput>;

export const VerifyPaymentInput = z.object({ notes: z.string().trim().max(500).default('') }).strict();
export type VerifyPaymentInput = z.infer<typeof VerifyPaymentInput>;
export const VoidPaymentInput = z.object({ reason }).strict();
export type VoidPaymentInput = z.infer<typeof VoidPaymentInput>;
export const ReversePaymentInput = z.object({ reason }).strict();
export type ReversePaymentInput = z.infer<typeof ReversePaymentInput>;

export const PaymentQuery = z.object({
  q: z.string().trim().max(200).default(''), page: z.coerce.number().int().min(1).max(1000000).default(1), perPage: z.coerce.number().int().min(1).max(100).default(20),
  status: PaymentStatus.optional(), method: PaymentMethod.optional(), subscriberId: z.uuid().optional(),
}).strict();
export type PaymentQueryInput = z.input<typeof PaymentQuery>;
export const AccountQuery = z.object({ subscriberId: z.uuid() }).strict();
export type AccountQueryInput = z.input<typeof AccountQuery>;
/** The proof bytes travel back to the desktop process, never a filesystem path. */
export const PaymentProofContentSchema = z.object({
  fileName: displayName, mimeType: z.enum(proofMimeValues), byteSize: z.number().int().positive(), base64: z.string(),
});
export type PaymentProofContent = z.infer<typeof PaymentProofContentSchema>;

export function formatReceiptNumber(year: number, value: number): string {
  return `RCT-${year}-${String(value).padStart(4, '0')}`;
}

export function receiptNumberYear(receiptNumber: string): number {
  return Number(receiptNumber.slice(4, 8));
}

export type OpenInvoice = { id: string; dueDate: string; issueDate: string; balanceCentavos: number };
export type AllocationStep = { invoiceId: string; amountCentavos: number };
export type AllocationPlan = { allocations: AllocationStep[]; appliedCentavos: number; advanceCentavos: number };

/**
 * Consumes the amount against the subscriber's open invoices, oldest due date first, and
 * keeps whatever is left as an advance credit. A void or draft invoice is never paid, a
 * zero or negative balance is skipped, and the caller receives the advance total back so
 * the same rule can settle a later invoice from a held credit.
 */
export function planAllocation(openInvoices: OpenInvoice[], amountCentavos: number): AllocationPlan {
  if (!Number.isInteger(amountCentavos) || amountCentavos < 0) throw new RangeError('The payment amount cannot be negative.');
  const order = [...openInvoices]
    .filter((invoice) => invoice.balanceCentavos > 0)
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.issueDate.localeCompare(right.issueDate) || left.id.localeCompare(right.id));
  const allocations: AllocationStep[] = [];
  let remaining = amountCentavos;
  for (const invoice of order) {
    if (remaining <= 0) break;
    const step = Math.min(invoice.balanceCentavos, remaining);
    allocations.push({ invoiceId: invoice.id, amountCentavos: step });
    remaining -= step;
  }
  return { allocations, appliedCentavos: amountCentavos - remaining, advanceCentavos: remaining };
}

/** Unallocated money held for a subscriber, taken from the payments that are already posted. */
export function advanceBalance(payments: { amountCentavos: number; appliedCentavos: number }[]): number {
  return payments.reduce((total, payment) => total + payment.amountCentavos - payment.appliedCentavos, 0);
}

export function proofExtension(mimeType: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'application/pdf') return '.pdf';
  return '';
}
