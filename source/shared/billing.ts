import { z } from 'zod';

// Shared billing contracts and pure money/date rules. The renderer may import this
// module to display values, but it never decides an amount: every figure below is
// recomputed and re-validated by the API inside the posting transaction.

export const invoiceStatusValues = ['DRAFT', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID', 'CREDITED'] as const;
export const invoiceItemTypeValues = ['SUBSCRIPTION', 'INSTALLATION', 'RECONNECTION', 'DISCOUNT', 'PENALTY', 'ADJUSTMENT'] as const;
export const ledgerReferenceValues = ['INVOICE', 'VOID', 'ADJUSTMENT', 'PAYMENT', 'CREDIT'] as const;

const money = z.number().int().min(0).max(999999999);
// A line always has a positive price, so a zero-value line can never be stored and a
// DISCOUNT line is guaranteed to be strictly negative.
const unitPrice = z.number().int().min(1).max(999999999);
const signedMoney = z.number().int().min(-999999999).max(999999999);
export const reason = z.string().trim().min(3).max(500);

export const InvoiceStatus = z.enum(invoiceStatusValues);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;
export const InvoiceItemType = z.enum(invoiceItemTypeValues);
export type InvoiceItemType = z.infer<typeof InvoiceItemType>;
export const PeriodCode = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, 'Use a YYYY-MM billing period.');
export const IsoDate = z.iso.date();
export type IsoDateString = z.infer<typeof IsoDate>;

// ---------------------------------------------------------------- date rules

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Calendar boundaries of a `YYYY-MM` period. */
export function cycleBounds(code: string): { periodStart: string; periodEnd: string } {
  const [year, month] = code.split('-').map(Number) as [number, number];
  return { periodStart: `${code}-01`, periodEnd: `${code}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}` };
}

export function shiftPeriod(code: string, months: number): string {
  const [year, month] = code.split('-').map(Number) as [number, number];
  const moved = new Date(Date.UTC(year, month - 1 + months, 1));
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Clamp a 1-31 billing/due day to the real last day of the month starting at `monthStart`. */
export function clampToMonth(monthStart: string, day: number): string {
  const [year, month] = monthStart.split('-').map(Number) as [number, number];
  const clamped = Math.min(Math.max(Math.trunc(day), 1), lastDayOfMonth(year, month));
  return `${monthStart.slice(0, 7)}-${String(clamped).padStart(2, '0')}`;
}

/**
 * Issue date is the service's billing day inside the cycle month. The due date is the
 * due day in the same month, or in the next month when the due day precedes the
 * billing day. Both are clamped, so day 31 in February resolves to the 28th/29th.
 */
export function billingDates(periodStart: string, billingDay: number, dueDay: number): { issueDate: string; dueDate: string } {
  const cyclePeriod = periodStart.slice(0, 7);
  const duePeriod = dueDay >= billingDay ? cyclePeriod : shiftPeriod(cyclePeriod, 1);
  return { issueDate: clampToMonth(`${cyclePeriod}-01`, billingDay), dueDate: clampToMonth(`${duePeriod}-01`, dueDay) };
}

export function periodLabel(code: string): string {
  const [year, month] = code.split('-').map(Number) as [number, number];
  return `${MONTHS[month - 1]} ${year}`;
}

export function periodOf(date: string): string { return date.slice(0, 7); }

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------- money rules

export function formatInvoiceNumber(year: number, value: number): string {
  return `INV-${year}-${String(value).padStart(4, '0')}`;
}

export function invoiceNumberYear(invoiceNumber: string): number {
  return Number(invoiceNumber.slice(4, 8));
}

export type LineAmount = { itemType: InvoiceItemType; quantity: number; unitPriceCentavos: number; amountCentavos?: number };

/**
 * Sign and amount of one line. `quantity x unit price` is always the magnitude, so a
 * stored line can never be edited into an unrelated figure. A DISCOUNT is always
 * negative; a debit/credit ADJUSTMENT carries its sign explicitly; everything else
 * is positive.
 */
export function lineAmount(line: LineAmount): number {
  const magnitude = line.quantity * line.unitPriceCentavos;
  if (!Number.isSafeInteger(magnitude) || magnitude > 999999999) throw new RangeError('Line amount exceeds the supported maximum.');
  const expected = line.itemType === 'DISCOUNT' ? -magnitude : magnitude;
  if (line.amountCentavos !== undefined) {
    if (Math.abs(line.amountCentavos) !== magnitude) throw new RangeError('The line amount must equal quantity multiplied by the unit price.');
    // Only a debit/credit ADJUSTMENT line may carry a caller-chosen sign.
    if (line.itemType === 'ADJUSTMENT') return line.amountCentavos;
    if (line.amountCentavos !== expected) throw new RangeError('Only an adjustment line may reverse the sign of its amount.');
    return expected;
  }
  return expected;
}

export type LineTotals = { subtotalCentavos: number; adjustmentCentavos: number; totalCentavos: number };

/** The invoice total is always the sum of its line amounts; the split is informational. */
export function sumLines(lines: LineAmount[]): LineTotals {
  let subtotalCentavos = 0; let adjustmentCentavos = 0;
  for (const line of lines) {
    const amount = lineAmount(line);
    if (line.itemType === 'DISCOUNT' || line.itemType === 'ADJUSTMENT') adjustmentCentavos += amount;
    else subtotalCentavos += amount;
  }
  // A credit may reduce a charge but never turn it negative; advance credit and
  // over-payment are handled as customer credit in Phase 5.
  if (subtotalCentavos + adjustmentCentavos < 0) throw new RangeError('The invoice total cannot be negative.');
  return { subtotalCentavos, adjustmentCentavos, totalCentavos: subtotalCentavos + adjustmentCentavos };
}

/**
 * Status is derived from the totals, never chosen by a caller. Only a settled invoice
 * is PAID; a settled-by-credit invoice is CREDITED and is produced by Phase 5.
 */
export function deriveStatus(input: { totalCentavos: number; paidCentavos: number; dueDate: string; asOf: string; voided?: boolean; settledByCredit?: boolean }): InvoiceStatus {
  if (input.voided) return 'VOID';
  const balanceCentavos = input.totalCentavos - input.paidCentavos;
  if (balanceCentavos <= 0) return input.settledByCredit ? 'CREDITED' : 'PAID';
  if (input.paidCentavos > 0) return 'PARTIALLY_PAID';
  return input.dueDate < input.asOf ? 'OVERDUE' : 'UNPAID';
}

export type LedgerEvent = { entryDate: string; entryNo: number; debitCentavos: number; creditCentavos: number; balanceCentavos: number };

/**
 * Reproduces the running balance from the immutable entries alone, ordered the same
 * way the ledger stores them. A mismatch against the stored column means a posting
 * bug, so callers treat a difference as a defect rather than a rounding matter.
 */
export function verifyRunningBalance(entries: LedgerEvent[]): { expected: Map<number, number>; differences: number[] } {
  const expected = new Map<number, number>();
  let running = 0;
  for (const entry of [...entries].sort((left, right) => (left.entryDate < right.entryDate ? -1 : left.entryDate > right.entryDate ? 1 : left.entryNo - right.entryNo))) {
    running += entry.debitCentavos - entry.creditCentavos;
    expected.set(entry.entryNo, running);
  }
  return { expected, differences: entries.filter((entry) => expected.get(entry.entryNo) !== entry.balanceCentavos).map((entry) => entry.entryNo) };
}

// ---------------------------------------------------------------- contracts

export const InvoiceItemSchema = z.object({
  id: z.uuid(), lineNo: z.number().int().positive(), itemType: InvoiceItemType, description: z.string(),
  serviceAccountId: z.string().nullable(), planId: z.string().nullable(), planVersion: z.number().int().nullable(),
  planCode: z.string(), planName: z.string(), quantity: z.number().int().positive(),
  unitPriceCentavos: unitPrice, amountCentavos: signedMoney,
});
export type InvoiceItem = z.infer<typeof InvoiceItemSchema>;

export const AdjustmentSchema = z.object({
  id: z.uuid(), adjustmentType: z.enum(['DEBIT', 'CREDIT']), amountCentavos: money, reason: z.string(),
  actorName: z.string(), createdAt: z.string(),
});
export type Adjustment = z.infer<typeof AdjustmentSchema>;

export const InvoiceSchema = z.object({
  id: z.uuid(), invoiceNumber: z.string().nullable(), status: InvoiceStatus, source: z.enum(['CYCLE', 'MANUAL']),
  periodLabel: z.string(), issueDate: IsoDate, dueDate: IsoDate,
  subtotalCentavos: money, adjustmentCentavos: signedMoney, totalCentavos: money, paidCentavos: money, balanceCentavos: money,
  notes: z.string(), voidReason: z.string(), createdAt: z.string(), finalizedAt: z.string().nullable(), voidedAt: z.string().nullable(),
  subscriberId: z.uuid(), subscriberCode: z.string(), subscriberName: z.string(),
  serviceAccountId: z.uuid(), serviceCode: z.string(), serviceAddress: z.string(),
  cycleCode: z.string().nullable(), items: z.array(InvoiceItemSchema), adjustments: z.array(AdjustmentSchema),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

export const InvoiceListSchema = z.object({ items: z.array(InvoiceSchema), total: z.number().int(), page: z.number().int(), perPage: z.number().int() });
export type InvoiceList = z.infer<typeof InvoiceListSchema>;

const runFields = {
  id: z.uuid(), cycleCode: z.string(), periodLabel: z.string(), asOf: IsoDate, invoiceCount: z.number().int(), skippedCount: z.number().int(),
  totalCentavos: money, actorName: z.string(), createdAt: z.string(),
};
/** The stored run, as returned by the generation command with its idempotency flag. */
export const BillingRunSchema = z.object({ ...runFields, idempotent: z.boolean() });
export type BillingRun = z.infer<typeof BillingRunSchema>;
/** One row of the run history; a stored run has no idempotency flag. */
export const BillingRunRowSchema = z.object(runFields);
export type BillingRunRow = z.infer<typeof BillingRunRowSchema>;

export const BillingRunListSchema = z.object({ items: z.array(BillingRunRowSchema), total: z.number().int(), page: z.number().int(), perPage: z.number().int() });
export type BillingRunList = z.infer<typeof BillingRunListSchema>;

export const BillingCycleSchema = z.object({ id: z.uuid(), code: z.string(), periodStart: IsoDate, periodEnd: IsoDate, generated: z.boolean(), invoiceCount: z.number().int() });
export type BillingCycle = z.infer<typeof BillingCycleSchema>;
export const BillingCycleListSchema = z.object({ items: z.array(BillingCycleSchema), total: z.number().int() });
export type BillingCycleList = z.infer<typeof BillingCycleListSchema>;

export const OverdueSweepSchema = z.object({ asOf: IsoDate, markedCount: z.number().int(), markedCentavos: money });
export type OverdueSweep = z.infer<typeof OverdueSweepSchema>;

export const LedgerEntrySchema = z.object({
  id: z.uuid(), entryNo: z.number().int().positive(), entryDate: IsoDate, referenceType: z.enum(ledgerReferenceValues), referenceNumber: z.string(),
  description: z.string(), debitCentavos: money, creditCentavos: money, balanceCentavos: z.number().int(),
  invoiceId: z.string().nullable(), invoiceNumber: z.string().nullable(), reversalOfId: z.string().nullable(), createdAt: z.string(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const LedgerSchema = z.object({
  subscriberId: z.uuid(), subscriberCode: z.string(), subscriberName: z.string(),
  openingBalanceCentavos: z.number().int(), closingBalanceCentavos: z.number().int(),
  totalDebitCentavos: money, totalCreditCentavos: money,
  items: z.array(LedgerEntrySchema), total: z.number().int(), page: z.number().int(), perPage: z.number().int(),
});
export type Ledger = z.infer<typeof LedgerSchema>;

export const GenerateRunInput = z.object({ period: PeriodCode, asOf: IsoDate.optional() }).strict();
export type GenerateRunInput = z.infer<typeof GenerateRunInput>;

export const LineInput = z.object({
  itemType: InvoiceItemType, description: z.string().trim().min(2).max(300), quantity: z.number().int().min(1).max(1000).default(1),
  unitPriceCentavos: unitPrice, amountCentavos: signedMoney.optional(),
}).strict();
export type LineInput = z.infer<typeof LineInput>;
export const DraftInvoiceInput = z.object({
  serviceAccountId: z.uuid(), issueDate: IsoDate, dueDate: IsoDate, notes: z.string().trim().max(500).default(''), items: z.array(LineInput).min(1).max(50),
}).strict().refine((value) => value.dueDate >= value.issueDate, { path: ['dueDate'], message: 'The due date cannot be before the issue date.' });
export type DraftInvoiceInput = z.infer<typeof DraftInvoiceInput>;
export const DraftItemsInput = z.object({ items: z.array(LineInput).min(1).max(50), reason }).strict();
export type DraftItemsInput = z.infer<typeof DraftItemsInput>;
export const AdjustmentInput = z.object({ adjustmentType: z.enum(['DEBIT', 'CREDIT']), amountCentavos: z.number().int().min(1).max(999999999), reason }).strict();
export type AdjustmentInput = z.infer<typeof AdjustmentInput>;
export const VoidInput = z.object({ reason }).strict();
export type VoidInput = z.infer<typeof VoidInput>;
// `asOf` lets an operator finalise a back-dated document without the status depending
// on the server clock; it defaults to today.
export const FinalizeInput = z.object({ reason, asOf: IsoDate.optional() }).strict();
export type FinalizeInput = z.infer<typeof FinalizeInput>;
export const OverdueSweepInput = z.object({ asOf: IsoDate.optional() }).strict();
export type OverdueSweepInput = z.infer<typeof OverdueSweepInput>;
export const InvoiceQuery = z.object({
  q: z.string().trim().max(200).default(''), page: z.coerce.number().int().min(1).max(1000000).default(1), perPage: z.coerce.number().int().min(1).max(100).default(20),
  status: InvoiceStatus.optional(), subscriberId: z.uuid().optional(), cycleCode: PeriodCode.optional(), serviceAccountId: z.uuid().optional(),
}).strict();
export type InvoiceQueryInput = z.input<typeof InvoiceQuery>;
export const LedgerQuery = z.object({
  subscriberId: z.uuid().optional(), from: IsoDate.optional(), to: IsoDate.optional(),
  page: z.coerce.number().int().min(1).max(1000000).default(1), perPage: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
export type LedgerQueryInput = z.input<typeof LedgerQuery>;
export const PageQuery = z.object({ page: z.coerce.number().int().min(1).max(1000000).default(1), perPage: z.coerce.number().int().min(1).max(100).default(20) }).strict();
export type PageQueryInput = z.input<typeof PageQuery>;

/** Exact conversion from UI decimal text; no floating-point monetary arithmetic. */
export function parseCentavos(value: string): number | null {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ''] = value.trim().split('.');
  const amount = Number(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')));
  return amount <= 999999999 ? amount : null;
}
export function decimalMoney(value: number): string {
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}
