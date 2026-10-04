import { z } from 'zod';
import { IsoDate, decimalMoney, daysBetween, reason } from './billing';

/**
 * Phase 7 contracts: receivables monitoring and service control.
 *
 * Two rules shape everything here.
 *
 * 1. A receivable is DERIVED from the open invoices, never stored. An aging bucket is a
 *    statement about invoices as they stand on a given day, so caching it would let the
 *    aging report disagree with the invoice ledger it claims to summarise.
 * 2. A suspension or reconnection is a DOCUMENT with a reason and an actor, never a flag.
 *    The service account status may change, but the reason, the effective date, who
 *    approved it and what it cost are kept, because "why is this customer disconnected"
 *    has to be answerable months later.
 */

const money = z.number().int().min(0).max(999999999);

// -------------------------------------------------------------- aging

/**
 * The laboratory's five aging buckets: Current, 1-30, 31-60, 61-90 and 90+ days.
 * The bucket is decided by how many days past the due date an invoice is, so an
 * invoice that is not yet due is always `CURRENT` and never ages while it is still
 * within terms.
 */
export const agingBucketValues = ['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS'] as const;
export const AgingBucket = z.enum(agingBucketValues);
export type AgingBucket = z.infer<typeof AgingBucket>;

/**
 * Puts an open invoice balance in its bucket for a given day. `overdueDays` is the number
 * of days past the due date; anything not yet due is current, and the boundaries are
 * inclusive at the top of each range so 30 days is `D1_30` and 31 is `D31_60`.
 */
export function agingBucket(overdueDays: number): AgingBucket {
  if (!Number.isInteger(overdueDays)) throw new RangeError('overdueDays must be a whole number of days.');
  if (overdueDays < 0) return 'CURRENT';
  if (overdueDays <= 30) return 'D1_30';
  if (overdueDays <= 60) return 'D31_60';
  if (overdueDays <= 90) return 'D61_90';
  return 'D90_PLUS';
}

/**
 * The published name of each band. It lives here rather than in a screen so the aging
 * report, the dashboard and the worklist all name a bucket the same way; a label invented
 * in the renderer is a label the exported PDF will not have.
 */
export const agingBucketLabels: Record<AgingBucket, string> = {
  CURRENT: 'Current (not yet due)', D1_30: '1 to 30 days', D31_60: '31 to 60 days', D61_90: '61 to 90 days', D90_PLUS: '90+ days',
};

/** Days past due for a due date, measured on `asOf`. Zero means due today, not overdue. */
export function overdueDays(dueDate: string, asOf: string): number {
  return Math.max(0, daysBetween(dueDate, asOf));
}

/**
 * An invoice that is settled by advance credit still shows a positive balance until the
 * credit is spent, so `CURRENT` here means "not yet past due" rather than "not owed".
 */
export function bucketAmount(bucket: AgingBucket, amounts: { [key in AgingBucket]: number }): number {
  return amounts[bucket];
}

/** Months unpaid counts distinct billing periods with an open balance, not invoice rows. */
export function monthsUnpaid(periodLabels: string[]): number {
  return new Set(periodLabels.map((label) => label.trim()).filter(Boolean)).size;
}

// -------------------------------------------------------------- receivables

export const ReceivableSummarySchema = z.object({
  asOf: IsoDate,
  // The day the figures were produced, which may differ from `asOf` when the report is
  // being read for a past date. Both are reported so a stale screen cannot look current.
  dataAsOf: IsoDate,
  currentReceivableCentavos: money,
  overdueReceivableCentavos: money,
  totalReceivableCentavos: money,
  subscriberCount: z.number().int().min(0),
  overdueSubscriberCount: z.number().int().min(0),
  followUpCount: z.number().int().min(0),
  suspensionCandidateCount: z.number().int().min(0),
  aging: z.array(z.object({ bucket: AgingBucket, invoiceCount: z.number().int().min(0), totalCentavos: money })),
});
export type ReceivableSummary = z.infer<typeof ReceivableSummarySchema>;

export const ReceivableRowSchema = z.object({
  serviceAccountId: z.uuid(),
  subscriberId: z.uuid(),
  subscriberCode: z.string(),
  subscriberName: z.string(),
  serviceCode: z.string(),
  planCode: z.string(),
  planName: z.string(),
  serviceType: z.string(),
  address: z.string(),
  areaId: z.uuid().nullable(),
  areaName: z.string(),
  collectorId: z.uuid().nullable(),
  collectorName: z.string(),
  currentCentavos: money,
  arrearsCentavos: money,
  totalArrearsCentavos: money,
  monthsUnpaid: z.number().int().min(0),
  oldestUnpaidDueDate: IsoDate,
  oldestUnpaidInvoiceNumber: z.string(),
  oldestUnpaidPeriodLabel: z.string(),
  bucket: AgingBucket,
  overdueDays: z.number().int().min(0),
  lastPaymentDate: IsoDate.nullable(),
  lastPaymentAmountCentavos: money,
  serviceStatus: z.string(),
  suspensionCandidate: z.boolean(),
});
export type ReceivableRow = z.infer<typeof ReceivableRowSchema>;

export const ReceivableListSchema = z.object({
  asOf: IsoDate,
  items: z.array(ReceivableRowSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  perPage: z.number().int().min(1),
});
export type ReceivableList = z.infer<typeof ReceivableListSchema>;

/** Only overdue rows, which is the laboratory's "overdue list" and the follow-up worklist. */
export const ReceivableQuery = z.object({
  asOf: IsoDate.optional(),
  collectorId: z.uuid().optional(),
  areaId: z.uuid().optional(),
  planId: z.uuid().optional(),
  serviceType: z.enum(['INTERNET', 'CABLE', 'COMBO']).optional(),
  bucket: AgingBucket.optional(),
  minOverdueDays: z.coerce.number().int().min(0).max(36500).optional(),
  includeCurrent: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export type ReceivableQueryInput = z.input<typeof ReceivableQuery>;

// -------------------------------------------------------------- service control

/**
 * Suspension is a document with its own lifecycle. A suspension that has been paid off is
 * not deleted: it moves to `LIFTED`, which is what lets the reconnection screen show that
 * the disconnection was resolved rather than quietly forgotten.
 */
export const suspensionStatusValues = ['ACTIVE', 'LIFTED', 'CANCELLED'] as const;
export const SuspensionStatus = z.enum(suspensionStatusValues);
export type SuspensionStatus = z.infer<typeof SuspensionStatus>;

export const reconnectionStatusValues = ['REQUESTED', 'ASSIGNED', 'COMPLETED', 'CANCELLED'] as const;
export const ReconnectionStatus = z.enum(reconnectionStatusValues);
export type ReconnectionStatus = z.infer<typeof ReconnectionStatus>;

/**
 * The policy is configurable, so the office decides how long it waits. The stored
 * suspension snapshots the policy that was in force on its effective date, because a
 * later policy change must not rewrite what a past decision was made under.
 */
export const ServicePolicySchema = z.object({
  id: z.uuid(),
  gracePeriodDays: z.number().int().min(0).max(365),
  suspensionThresholdCentavos: money,
  autoSuspend: z.boolean(),
  reconnectionFeeCentavos: money,
  updatedBy: z.string(),
  updatedName: z.string(),
  updatedAt: z.string(),
});
export type ServicePolicy = z.infer<typeof ServicePolicySchema>;

export const SuspensionSchema = z.object({
  id: z.uuid(),
  suspensionNumber: z.string(),
  serviceAccountId: z.uuid(),
  serviceCode: z.string(),
  subscriberCode: z.string(),
  subscriberName: z.string(),
  planCode: z.string(),
  serviceType: z.string(),
  address: z.string(),
  areaId: z.uuid().nullable(),
  areaName: z.string(),
  collectorId: z.uuid().nullable(),
  collectorName: z.string(),
  status: SuspensionStatus,
  reason: z.string(),
  notes: z.string(),
  effectiveDate: IsoDate,
  gracePeriodDays: z.number().int().min(0),
  thresholdCentavos: money,
  arrearsAtSuspensionCentavos: money,
  monthsUnpaidAtSuspension: z.number().int().min(0),
  approvedBy: z.string(),
  approvedName: z.string(),
  createdAt: z.string(),
  liftedAt: IsoDate.nullable(),
  liftedByName: z.string().nullable(),
  reconnectionId: z.uuid().nullable(),
  reconnectionNumber: z.string().nullable(),
  reconnectionStatus: ReconnectionStatus.nullable(),
  reconnectionFeeCentavos: money,
  reconnectionRequestDate: IsoDate.nullable(),
  reconnectionCompletedDate: IsoDate.nullable(),
  technicianId: z.uuid().nullable(),
  technicianName: z.string().nullable(),
});
export type Suspension = z.infer<typeof SuspensionSchema>;

export const SuspensionListSchema = z.object({
  items: z.array(SuspensionSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  perPage: z.number().int().min(1),
});
export type SuspensionList = z.infer<typeof SuspensionListSchema>;

/**
 * A service account's control history, read from the same append-only history that records
 * every master-data change, so a suspension appears in the service history the technician
 * already reads.
 */
export const ServiceControlEventSchema = z.object({
  id: z.uuid(),
  eventType: z.enum(['SUSPENDED', 'LIFTED', 'RECONNECTION_REQUESTED', 'RECONNECTION_ASSIGNED', 'RECONNECTION_COMPLETED', 'RECONNECTION_CANCELLED']),
  summary: z.string(),
  reason: z.string(),
  amountCentavos: money,
  effectiveDate: IsoDate,
  actorName: z.string(),
  createdAt: z.string(),
});
export type ServiceControlEvent = z.infer<typeof ServiceControlEventSchema>;

export const SuspendServiceInput = z.object({
  reason: reason,
  notes: z.string().trim().max(500).default(''),
  effectiveDate: IsoDate.optional(),
}).strict();
export type SuspendServiceInput = z.infer<typeof SuspendServiceInput>;

/** Lifting requires a reason as well, because a disconnection is never silently undone. */
export const LiftSuspensionInput = z.object({ reason }).strict();
export type LiftSuspensionInput = z.infer<typeof LiftSuspensionInput>;

export const RequestReconnectionInput = z.object({
  // Left out, the fee comes from the policy, so a clerk does not have to know the tariff.
  feeCentavos: z.number().int().min(0).max(999999999).optional(),
  technicianId: z.uuid().optional(),
  notes: z.string().trim().max(500).default(''),
  requestedOn: IsoDate.optional(),
}).strict();
export type RequestReconnectionInput = z.infer<typeof RequestReconnectionInput>;

export const AssignTechnicianInput = z.object({ technicianId: z.uuid(), notes: z.string().trim().max(500).default('') }).strict();
export type AssignTechnicianInput = z.infer<typeof AssignTechnicianInput>;

export const CompleteReconnectionInput = z.object({ completedOn: IsoDate.optional(), notes: z.string().trim().max(500).default('') }).strict();
export type CompleteReconnectionInput = z.infer<typeof CompleteReconnectionInput>;

/**
 * A technician is offered as an assignment option, and is listed by the API rather than
 * filtered in the renderer, so an unassigned technician can never be named by the desktop.
 */
export const ServiceTechnicianSchema = z.object({ id: z.uuid(), displayName: z.string(), username: z.string() });
export type ServiceTechnician = z.infer<typeof ServiceTechnicianSchema>;

export const UpdatePolicyInput = z.object({
  gracePeriodDays: z.number().int().min(0).max(365),
  suspensionThresholdCentavos: z.number().int().min(0).max(999999999),
  autoSuspend: z.boolean(),
  reconnectionFeeCentavos: z.number().int().min(0).max(999999999),
  reason,
}).strict();
export type UpdatePolicyInput = z.infer<typeof UpdatePolicyInput>;

export const SuspensionQuery = z.object({
  status: SuspensionStatus.optional(),
  collectorId: z.uuid().optional(),
  areaId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export type SuspensionQueryInput = z.input<typeof SuspensionQuery>;

/** Gap-free per-year numbering, so a suspension number proves a document exists. */
export function formatSuspensionNumber(year: number, value: number): string {
  return `SUS-${year}-${String(value).padStart(4, '0')}`;
}

export function formatReconnectionNumber(year: number, value: number): string {
  return `RCO-${year}-${String(value).padStart(4, '0')}`;
}

/**
 * Whether an account qualifies for suspension on a given day. The threshold is compared
 * against the arrears total, not against a single invoice, so a customer who owes a small
 * amount on many months is treated the same as one who owes the same total in a single
 * bill. The grace period is measured from the oldest unpaid due date, so a payment resets
 * the clock by advancing that date.
 */
export function qualifiesForSuspension(input: {
  arrearsCentavos: number; oldestUnpaidDueDate: string; asOf: string; thresholdCentavos: number; gracePeriodDays: number;
}): { eligible: boolean; overdueDays: number; reason: 'BELOW_THRESHOLD' | 'WITHIN_GRACE' | 'ELIGIBLE' } {
  const days = overdueDays(input.oldestUnpaidDueDate, input.asOf);
  if (input.arrearsCentavos < input.thresholdCentavos) return { eligible: false, overdueDays: days, reason: 'BELOW_THRESHOLD' };
  if (days < input.gracePeriodDays) return { eligible: false, overdueDays: days, reason: 'WITHIN_GRACE' };
  return { eligible: true, overdueDays: days, reason: 'ELIGIBLE' };
}

/** A reconnection may only be requested once the arrears have actually been cleared. */
export function reconnectionBlockedBy(arrearsCentavos: number): string | null {
  if (arrearsCentavos > 0) return 'The account still has an outstanding balance. Pay it before requesting reconnection.';
  return null;
}

export { decimalMoney };

/** Centavos as a peso string, for display only: no arithmetic is ever done on the result. */
export const moneyLabel = (centavos: number) => `PHP ${decimalMoney(centavos)}`;
