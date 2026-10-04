import { z } from 'zod';
import { IsoDate, decimalMoney, reason } from './billing';

/**
 * Phase 6 contracts. A collection batch is a day's work list for one collector in one
 * area. The account list and the expected amounts are frozen into the batch when it is
 * opened, so the sheet the collector carries is the sheet the office reconciles against.
 * Every collected figure is derived from the posted payments that carry the batch, which
 * is what keeps a batch and the payment ledger from ever disagreeing.
 */
export const batchStatusValues = ['OPEN', 'IN_PROGRESS', 'SUBMITTED', 'REMITTED', 'RECONCILED', 'CLOSED'] as const;
export const BatchStatus = z.enum(batchStatusValues);
export type BatchStatus = z.infer<typeof BatchStatus>;

/** Per-account progress on the route, derived from the collected total against the snapshot. */
export const batchAccountStatusValues = ['PENDING', 'PARTIAL', 'COLLECTED', 'OVERPAID'] as const;
export const BatchAccountStatus = z.enum(batchAccountStatusValues);
export type BatchAccountStatus = z.infer<typeof BatchAccountStatus>;

/** A route sheet is bounded so one batch can never be an unbounded document. */
export const routeAccountLimit = 500;

/** Gap-free counters shared with billing, so a batch and a remittance number prove a document. */
export const documentSequenceKinds = ['INVOICE', 'RECEIPT', 'BATCH', 'REMITTANCE', 'SUSPENSION', 'RECONNECTION'] as const;

const money = z.number().int().min(0).max(999999999);

// -------------------------------------------------------------- numbering

export function formatBatchNumber(year: number, value: number): string {
  return `BCH-${year}-${String(value).padStart(4, '0')}`;
}

export function formatRemittanceNumber(year: number, value: number): string {
  return `RMT-${year}-${String(value).padStart(4, '0')}`;
}

// -------------------------------------------------------------- lifecycle

/**
 * The batch lifecycle is a straight line with no branch: a route is opened, worked,
 * handed in, reconciled and finally closed. Nothing can skip a step or move backwards,
 * so "remitted" always means the money was counted and recorded against the sheet.
 */
export const batchTransitions: Record<BatchStatus, BatchStatus[]> = {
  OPEN: ['IN_PROGRESS'],
  IN_PROGRESS: ['SUBMITTED'],
  SUBMITTED: ['REMITTED'],
  REMITTED: ['RECONCILED'],
  RECONCILED: ['CLOSED'],
  CLOSED: [],
};

export function canTransition(from: BatchStatus, to: BatchStatus): boolean {
  return batchTransitions[from].includes(to);
}

/** Only an open or in-progress route accepts a collection; after submission the sheet is frozen. */
export function isCollectable(status: BatchStatus): boolean {
  return status === 'OPEN' || status === 'IN_PROGRESS';
}

// -------------------------------------------------------------- arithmetic

/**
 * AT-07 and AT-08: the money that should have been handed in against the money that was.
 * The difference is reported as an explicit shortage or overage and is never balanced away
 * silently, so a remittance that does not match stays visible until someone reconciles it.
 */
export function reconcileCash(expectedCashCentavos: number, remittedCashCentavos: number): { balanced: boolean; shortageCentavos: number; overageCentavos: number } {
  if (!Number.isInteger(expectedCashCentavos) || expectedCashCentavos < 0) throw new RangeError('The expected cash cannot be negative.');
  if (!Number.isInteger(remittedCashCentavos) || remittedCashCentavos < 0) throw new RangeError('The remitted cash cannot be negative.');
  const difference = remittedCashCentavos - expectedCashCentavos;
  return {
    balanced: difference === 0,
    shortageCentavos: difference < 0 ? -difference : 0,
    overageCentavos: difference > 0 ? difference : 0,
  };
}

export function batchAccountStatus(totalDueCentavos: number, collectedCentavos: number): BatchAccountStatus {
  if (collectedCentavos <= 0) return 'PENDING';
  if (collectedCentavos < totalDueCentavos) return 'PARTIAL';
  return collectedCentavos === totalDueCentavos ? 'COLLECTED' : 'OVERPAID';
}

export type BatchFigures = {
  expectedReceivableCentavos: number;
  cashCollectedCentavos: number;
  nonCashCollectedCentavos: number;
  pendingClaimCentavos: number;
};

/**
 * The four figures a collection sheet is judged by, and the three that follow from them.
 * Uncollected is what the route did not bring in, and over-collected is what it brought in
 * above the amounts that were due; the two are reported separately so neither hides the other.
 */
export function batchSummary(
  accounts: { totalDueCentavos: number; collectedCentavos: number }[],
  figures: BatchFigures,
) {
  const uncollectedCentavos = accounts.reduce((total, account) => total + Math.max(0, account.totalDueCentavos - account.collectedCentavos), 0);
  const overCollectedCentavos = accounts.reduce((total, account) => total + Math.max(0, account.collectedCentavos - account.totalDueCentavos), 0);
  return {
    ...figures,
    totalCollectedCentavos: figures.cashCollectedCentavos + figures.nonCashCollectedCentavos,
    uncollectedCentavos,
    overCollectedCentavos,
    accountCount: accounts.length,
    accountsCollected: accounts.filter((account) => batchAccountStatus(account.totalDueCentavos, account.collectedCentavos) === 'COLLECTED').length,
    accountsPartial: accounts.filter((account) => batchAccountStatus(account.totalDueCentavos, account.collectedCentavos) === 'PARTIAL').length,
    accountsUnpaid: accounts.filter((account) => batchAccountStatus(account.totalDueCentavos, account.collectedCentavos) === 'PENDING').length,
  };
}

export type BatchSummary = ReturnType<typeof batchSummary>;

// -------------------------------------------------------------- documents

/** One frozen line of the route: who was visited, where, and what was owed that day. */
export const BatchAccountSchema = z.object({
  id: z.uuid(), subscriberId: z.uuid(), subscriberCode: z.string(), subscriberName: z.string(), address: z.string(),
  currentBillCentavos: money, arrearsCentavos: money, totalDueCentavos: money, collectedCentavos: money,
  status: BatchAccountStatus,
});
export type BatchAccount = z.infer<typeof BatchAccountSchema>;

/** The immutable count of what the collector handed in, kept for ever even if the batch changes later. */
export const BatchRemittanceSchema = z.object({
  id: z.uuid(), batchId: z.uuid(), remittanceNumber: z.string(), remittedOn: IsoDate,
  expectedCashCentavos: money, cashCentavos: money, shortageCentavos: money, overageCentavos: money,
  balanced: z.boolean(), notes: z.string(), recordedBy: z.string(), recordedName: z.string(), createdAt: z.string(),
});
export type BatchRemittance = z.infer<typeof BatchRemittanceSchema>;

export const BatchSchema = z.object({
  id: z.uuid(), batchNumber: z.string(), status: BatchStatus,
  collectorId: z.uuid(), collectorName: z.string(), areaId: z.uuid(), areaName: z.string(),
  collectionDate: IsoDate,
  expectedReceivableCentavos: money, cashCollectedCentavos: money, nonCashCollectedCentavos: money,
  pendingClaimCentavos: money, totalCollectedCentavos: money, uncollectedCentavos: money, overCollectedCentavos: money,
  accountCount: z.number().int(), accountsCollected: z.number().int(), accountsPartial: z.number().int(), accountsUnpaid: z.number().int(),
  shortageCentavos: money, overageCentavos: money, balanced: z.boolean(),
  startedAt: z.string().nullable(), submittedAt: z.string().nullable(), remittedAt: z.string().nullable(),
  reconciledAt: z.string().nullable(), reconciledName: z.string().nullable(), reconciliationNotes: z.string(),
  closedAt: z.string().nullable(), createdBy: z.string(), createdName: z.string(), createdAt: z.string(),
});
export type Batch = z.infer<typeof BatchSchema>;

/** The batch with its frozen accounts, its derived figures and its remittance, which is one read. */
export const BatchDetailSchema = BatchSchema.extend({
  accounts: z.array(BatchAccountSchema), remittance: BatchRemittanceSchema.nullable(),
});
export type BatchDetail = z.infer<typeof BatchDetailSchema>;

export const BatchListSchema = z.object({
  items: z.array(BatchSchema), total: z.number().int(), page: z.number().int(), perPage: z.number().int(),
});
export type BatchList = z.infer<typeof BatchListSchema>;

/**
 * The printable route sheet. It is a projection of the batch detail with a print header, so
 * what an operator prints is exactly what the server holds and nothing is recomputed here.
 */
export const RouteSheetSchema = z.object({
  batchNumber: z.string(), collectionDate: IsoDate, status: BatchStatus, collectorName: z.string(), areaName: z.string(),
  accounts: z.array(BatchAccountSchema),
  totals: z.object({
    expectedReceivableCentavos: money, cashCollectedCentavos: money, nonCashCollectedCentavos: money,
    totalCollectedCentavos: money, uncollectedCentavos: money, accountCount: z.number().int(),
  }),
  generatedAt: z.string(),
});
export type RouteSheet = z.infer<typeof RouteSheetSchema>;

// -------------------------------------------------------------- commands

export const CreateBatchInput = z.object({
  collectorId: z.uuid(), areaId: z.uuid(), collectionDate: IsoDate,
  notes: z.string().trim().max(500).default(''),
  // An explicit list narrows the route to chosen accounts; without it the whole area is used.
  subscriberIds: z.array(z.uuid()).min(1).max(routeAccountLimit).optional(),
}).strict();
export type CreateBatchInput = z.infer<typeof CreateBatchInput>;

export const SubmitBatchInput = z.object({ notes: z.string().trim().max(500).default('') }).strict();
export type SubmitBatchInput = z.infer<typeof SubmitBatchInput>;

/** A nil remittance is legitimate, so the amount is bounded at zero rather than one. */
export const RemittanceInput = z.object({ remittedOn: IsoDate, cashCentavos: money, notes: z.string().trim().max(500).default('') }).strict();
export type RemittanceInput = z.infer<typeof RemittanceInput>;

/** Reconciliation always carries a written reason: a balanced sheet is signed, a shortage is explained. */
export const ReconcileBatchInput = z.object({ notes: reason }).strict();
export type ReconcileBatchInput = z.infer<typeof ReconcileBatchInput>;

export const CloseBatchInput = z.object({}).strict();
export type CloseBatchInput = z.infer<typeof CloseBatchInput>;

export const BatchQuery = z.object({
  q: z.string().trim().max(200).default(''), page: z.coerce.number().int().min(1).max(1000000).default(1), perPage: z.coerce.number().int().min(1).max(100).default(20),
  status: BatchStatus.optional(), collectorId: z.uuid().optional(), areaId: z.uuid().optional(),
}).strict();
export type BatchQueryInput = z.input<typeof BatchQuery>;

/** The sheet is printed from these figures, which are exactly the ones the server derived. */
export function routeSheetTotals(detail: BatchDetail) {
  return {
    expectedReceivableCentavos: detail.expectedReceivableCentavos,
    cashCollectedCentavos: detail.cashCollectedCentavos,
    nonCashCollectedCentavos: detail.nonCashCollectedCentavos,
    totalCollectedCentavos: detail.totalCollectedCentavos,
    uncollectedCentavos: detail.uncollectedCentavos,
    accountCount: detail.accountCount,
  };
}

export const moneyLabel = (centavos: number) => `PHP ${decimalMoney(centavos)}`;
