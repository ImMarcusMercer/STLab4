import { z } from 'zod';
import { IsoDate, decimalMoney, daysBetween } from './billing';
import { AgingBucket } from './receivables';

/**
 * Phase 8 contracts: management reports, the dashboard and document exports.
 *
 * Three rules shape this module.
 *
 * 1. A REPORT IS A QUERY. Nothing here is a stored snapshot, so no figure can go stale
 *    while still looking authoritative. Every row is recomputed from the posted financial
 *    rows at the moment the report is asked for.
 * 2. A REPORT PROVES ITS OWN ARITHMETIC. `totals` is what the report claims and
 *    `reconciliations` is the sum of the rows beside it, so a reader can see the check
 *    rather than take the total on trust. `assertBalanced` refuses to publish a report
 *    whose rows do not add up.
 * 3. MONEY IS AN INTEGER ALL THE WAY OUT. Rows and totals carry centavos; the peso string
 *    is produced once at the display and export edge. No report ever sums a float.
 */

const money = z.number().int().max(999999999);
const DAY = 86_400_000;

// -------------------------------------------------------------- report codes

export const reportValues = [
  'COLLECTIONS', 'BILLING_VS_COLLECTION', 'REVENUE', 'AR_AGING', 'SUBSCRIBER_LEDGER',
  'SUBSCRIBER_MASTER', 'COLLECTOR_PERFORMANCE', 'PAYMENT_EXCEPTIONS', 'AUDIT_TRAIL',
] as const;
export const ReportCode = z.enum(reportValues);
export type ReportCode = z.infer<typeof ReportCode>;

/**
 * The period bucket a period report is grouped by. The same four granularities answer the
 * laboratory's daily, weekly, monthly and annual collection reports, so `COLLECTIONS` is one
 * query rather than four.
 */
export const granularityValues = ['DAY', 'WEEK', 'MONTH', 'YEAR'] as const;
export const Granularity = z.enum(granularityValues);
export type Granularity = z.infer<typeof Granularity>;

/** `REVENUE` is grouped by one of these three dimensions. */
export const dimensionValues = ['PLAN', 'SERVICE_TYPE', 'AREA'] as const;
export const Dimension = z.enum(dimensionValues);
export type Dimension = z.infer<typeof Dimension>;

export const exportFormatValues = ['PDF', 'XLSX', 'CSV'] as const;
export const ExportFormat = z.enum(exportFormatValues);
export type ExportFormat = z.infer<typeof ExportFormat>;

export type ReportDefinition = {
  code: ReportCode;
  title: string;
  description: string;
  /** Grouping choices the desktop may offer. */
  granularity: boolean;
  dimension: Dimension[];
  /** The report only makes sense for one account. */
  requiresSubscriber: boolean;
  /** The report is a snapshot of one day rather than a period. */
  snapshot: boolean;
  permission: 'report.view';
};

export const reportCatalogue: Record<ReportCode, ReportDefinition> = {
  COLLECTIONS: {
    code: 'COLLECTIONS', title: 'Collection summary',
    description: 'Cash and GCash collected in each period, with the receipts behind each figure.',
    granularity: true, dimension: [], requiresSubscriber: false, snapshot: false, permission: 'report.view',
  },
  BILLING_VS_COLLECTION: {
    code: 'BILLING_VS_COLLECTION', title: 'Billing versus collection',
    description: 'What each period billed against what it collected, and the difference still to collect.',
    granularity: true, dimension: [], requiresSubscriber: false, snapshot: false, permission: 'report.view',
  },
  REVENUE: {
    code: 'REVENUE', title: 'Revenue by plan, service or area',
    description: 'Billed and collected revenue grouped by plan, service type or collection area.',
    granularity: true, dimension: ['PLAN', 'SERVICE_TYPE', 'AREA'], requiresSubscriber: false, snapshot: false, permission: 'report.view',
  },
  AR_AGING: {
    code: 'AR_AGING', title: 'Accounts receivable aging',
    description: 'Everything owed today, split into the five published aging buckets.',
    granularity: false, dimension: [], requiresSubscriber: false, snapshot: true, permission: 'report.view',
  },
  SUBSCRIBER_LEDGER: {
    code: 'SUBSCRIBER_LEDGER', title: 'Statement of account',
    description: 'One subscriber’s complete debit and credit history for a date range, with a reproducible running balance.',
    granularity: false, dimension: [], requiresSubscriber: true, snapshot: false, permission: 'report.view',
  },
  SUBSCRIBER_MASTER: {
    code: 'SUBSCRIBER_MASTER', title: 'Subscriber master list',
    description: 'Every subscriber with their services, assignment and current balance.',
    granularity: false, dimension: [], requiresSubscriber: false, snapshot: false, permission: 'report.view',
  },
  COLLECTOR_PERFORMANCE: {
    code: 'COLLECTOR_PERFORMANCE', title: 'Collector performance',
    description: 'Assigned accounts, expected cash, cash remitted and any shortage or overage that is still on the record.',
    granularity: true, dimension: [], requiresSubscriber: false, snapshot: false, permission: 'report.view',
  },
  PAYMENT_EXCEPTIONS: {
    code: 'PAYMENT_EXCEPTIONS', title: 'Payment exceptions',
    description: 'Voided receipts, reversals and GCash claims still awaiting a second person.',
    granularity: false, dimension: [], requiresSubscriber: false, snapshot: false, permission: 'report.view',
  },
  AUDIT_TRAIL: {
    code: 'AUDIT_TRAIL', title: 'User activity and audit trail',
    description: 'Every recorded action, with the actor, the date and the reason.',
    granularity: false, dimension: [], requiresSubscriber: false, snapshot: false, permission: 'report.view',
  },
};

export const reportCodes = () => Object.keys(reportCatalogue) as ReportCode[];
export const reportTitle = (code: ReportCode) => reportCatalogue[code].title;

/**
 * One entry as the desktop receives it. `exportable` is answered by the server from the
 * signed-in user's permissions, so the renderer can hide a button it knows would be refused
 * instead of offering one and reporting a failure afterwards.
 */
export const ReportCatalogueEntrySchema = z.object({
  code: ReportCode,
  title: z.string(),
  description: z.string(),
  granularity: z.boolean(),
  dimension: z.array(Dimension),
  requiresSubscriber: z.boolean(),
  snapshot: z.boolean(),
  permission: z.literal('report.view'),
  exportable: z.boolean(),
});
export type ReportCatalogueEntry = z.infer<typeof ReportCatalogueEntrySchema>;

export const ReportCatalogueSchema = z.object({
  generatedAt: z.string(),
  reports: z.array(ReportCatalogueEntrySchema),
});
export type ReportCatalogue = z.infer<typeof ReportCatalogueSchema>;

// -------------------------------------------------------------- columns and rows

export const reportColumnKindValues = ['TEXT', 'MONEY', 'NUMBER', 'DATE', 'STATUS'] as const;
export const ReportColumnKind = z.enum(reportColumnKindValues);
export type ReportColumnKind = z.infer<typeof ReportColumnKind>;

export const ReportColumnSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(80),
  kind: ReportColumnKind,
  align: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
  /** Relative column weight for the PDF and XLSX layouts. */
  width: z.number().int().min(4).max(120).optional(),
  /**
   * Set on a money column that holds a running balance rather than an amount. Adding up the
   * running balance on a statement of account would compare a total against a sum of
   * balances and always disagree, so such a column is excluded from the reconciliation
   * rather than quietly reconciled against the wrong figure.
   */
  runningTotal: z.boolean().default(false),
});
export type ReportColumn = z.infer<typeof ReportColumnSchema>;

/**
 * A cell is a string, a whole number, a boolean or nothing. Nothing is ever a float: a
 * money cell is always integer centavos, so summing a column is exact.
 */
export const ReportCellSchema = z.union([z.string(), z.number().int(), z.boolean(), z.null()]);
export type ReportCell = z.infer<typeof ReportCellSchema>;
export const ReportRowSchema = z.record(z.string(), ReportCellSchema);
export type ReportRow = z.infer<typeof ReportRowSchema>;

export const ReportTotalSchema = z.object({
  label: z.string().min(1).max(80),
  values: z.record(z.string(), ReportCellSchema),
  /** Rendered heavier, for a grand total or a net figure. */
  emphasis: z.boolean().default(false),
});
export type ReportTotal = z.infer<typeof ReportTotalSchema>;

/**
 * One arithmetic proof: the sum of a money column down the rows, beside the total the
 * report states for it. `balanced` is the answer, and the server refuses a report when
 * any of these is false.
 */
export const ReconciliationSchema = z.object({
  label: z.string().min(1).max(120),
  column: z.string().min(1).max(60),
  summedCentavos: money,
  statedCentavos: money,
  balanced: z.boolean(),
});
export type Reconciliation = z.infer<typeof ReconciliationSchema>;

/**
 * The account a document is about, when it is about exactly one.
 *
 * A statement of account is not a management report: it is handed to one subscriber, and the
 * account it belongs to has to be printed on the paper. A report that summarises the whole
 * office has nothing to name, so this stays null and the header is unchanged.
 */
export const ReportSubjectSchema = z.object({
  label: z.string(),
  fields: z.array(z.object({ label: z.string(), value: z.string() })).min(1),
});
export type ReportSubject = z.infer<typeof ReportSubjectSchema>;

export const ReportTableSchema = z.object({
  code: ReportCode,
  title: z.string(),
  description: z.string(),
  periodLabel: z.string(),
  from: IsoDate,
  to: IsoDate,
  /** Set for a snapshot report, which answers "today" rather than a range. */
  asOf: IsoDate.nullable(),
  /** Null for a report about the whole office; set for a document handed to one account. */
  subject: ReportSubjectSchema.nullable().default(null),
  generatedAt: z.string(),
  generatedBy: z.string(),
  columns: z.array(ReportColumnSchema),
  rows: z.array(ReportRowSchema),
  totals: z.array(ReportTotalSchema),
  reconciliations: z.array(ReconciliationSchema),
  footnote: z.string(),
  /** True when the export was bounded, so a partial file never looks complete. */
  truncated: z.boolean(),
  rowCount: z.number().int().min(0),
});
export type ReportTable = z.infer<typeof ReportTableSchema>;

/** A report with no rows is still a valid report, so the empty envelope is published too. */
export function emptyTable(input: Pick<ReportTable, 'code' | 'from' | 'to' | 'generatedAt' | 'generatedBy'>): ReportTable {
  return {
    code: input.code,
    title: reportTitle(input.code),
    description: reportCatalogue[input.code].description,
    periodLabel: `${input.from} to ${input.to}`,
    from: input.from,
    to: input.to,
    asOf: reportCatalogue[input.code].snapshot ? input.to : null,
    subject: null,
    generatedAt: input.generatedAt,
    generatedBy: input.generatedBy,
    columns: [],
    rows: [],
    totals: [],
    reconciliations: [],
    footnote: 'No rows matched this period.',
    truncated: false,
    rowCount: 0,
  };
}

// -------------------------------------------------------------- reconciliation

export const sumColumn = (rows: ReportRow[], column: string): number => {
  let total = 0;
  for (const row of rows) {
    const value = row[column];
    if (value === undefined || value === null) continue;
    // `ReportRow` types a cell as `number`, which admits a float at the type level, and a
    // float that reaches this function would be carried into a total nobody can reproduce.
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new TypeError(`Column "${column}" must hold whole-number centavos, not ${typeof value === 'number' ? value : typeof value}.`);
    }
    total += value;
  }
  if (!Number.isSafeInteger(total)) throw new RangeError('A report total exceeded the supported range.');
  return total;
};

/**
 * Compares the sum of a money column against the total the report states for it. Both are
 * integer centavos, so this is an exact comparison and never a rounding question.
 */
export function reconcileMoney(label: string, column: string, rows: ReportRow[], totals: ReportTotal[]): Reconciliation {
  const summedCentavos = sumColumn(rows, column);
  const stated = totals.find((total) => total.values[column] !== undefined)?.values[column];
  const statedCentavos = typeof stated === 'number' ? stated : 0;
  return { label, column, summedCentavos, statedCentavos, balanced: summedCentavos === statedCentavos };
}

/** Reconciles every additive money column, so a report cannot silently forget one. */
export function reconcileAll(columns: ReportColumn[], rows: ReportRow[], totals: ReportTotal[]): Reconciliation[] {
  return columns
    .filter((column) => column.kind === 'MONEY' && !column.runningTotal)
    .map((column) => reconcileMoney(`Rows equal the stated ${column.label.toLowerCase()}`, column.key, rows, totals));
}

/**
 * The server-side invariant. A report whose rows disagree with its totals is a defect, not
 * a formatting matter, so it is refused rather than published and defended in the demo.
 */
export function assertBalanced(reconciliations: Reconciliation[]): Reconciliation[] {
  const broken = reconciliations.filter((entry) => !entry.balanced);
  if (broken.length > 0) {
    const detail = broken.map((entry) => `${entry.column}: rows ${entry.summedCentavos} against stated ${entry.statedCentavos}`).join('; ');
    throw new Error(`Report totals do not reconcile (${detail}).`);
  }
  return reconciliations;
}

// -------------------------------------------------------------- period bucketing

const pad = (value: number) => String(value).padStart(2, '0');
const iso = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const parseDate = (value: string) => new Date(`${value}T00:00:00Z`);

/** Monday of the ISO week containing `date`, in UTC. */
function mondayOf(date: Date): Date {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day;
}

/**
 * ISO-8601 week number. The Monday of a week can fall in the previous calendar year (29 Dec
 * 2026 is in 2027-W01), so the year is taken from the week's Thursday rather than from the
 * date, which is what keeps a week from being counted twice.
 */
function isoWeek(date: Date): { year: number; week: number } {
  const thursday = mondayOf(date);
  thursday.setUTCDate(thursday.getUTCDate() + 3);
  const year = thursday.getUTCFullYear();
  const firstThursday = mondayOf(new Date(Date.UTC(year, 0, 4)));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3);
  return { year, week: 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY)) };
}

/**
 * The bucket key for a date. These strings are byte-identical to what the SQL reports group
 * by (`YYYY-MM-DD`, `IYYY-"W"IW`, `YYYY-MM`, `YYYY`), so the period rows a report returns
 * can be checked against this function instead of trusted.
 */
export function bucketKey(date: string, granularity: Granularity): string {
  const value = parseDate(date);
  if (Number.isNaN(value.getTime())) throw new RangeError(`Not a calendar date: ${date}`);
  if (granularity === 'DAY') return iso(value);
  if (granularity === 'MONTH') return date.slice(0, 7);
  if (granularity === 'YEAR') return date.slice(0, 4);
  const { year, week } = isoWeek(value);
  return `${year}-W${pad(week)}`;
}

/**
 * The calendar range a bucket covers. The key is checked against the granularity first: a
 * week key handed to the month branch would otherwise return the whole of October for what
 * was asked as a week, which is a wrong answer rather than an error.
 */
export function bucketBounds(key: string, granularity: Granularity): { from: string; to: string } {
  const shapes: Record<Granularity, RegExp> = {
    DAY: /^\d{4}-\d{2}-\d{2}$/, MONTH: /^\d{4}-\d{2}$/, YEAR: /^\d{4}$/, WEEK: /^\d{4}-W\d{2}$/,
  };
  if (!shapes[granularity].test(key)) {
    throw new RangeError(`"${key}" is not a ${granularity.toLowerCase()} bucket key.`);
  }
  if (granularity === 'DAY') return { from: key, to: key };
  if (granularity === 'MONTH') {
    const [year, month] = key.split('-').map(Number) as [number, number];
    if (month < 1 || month > 12) throw new RangeError(`"${key}" is not a calendar month.`);
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { from: `${key}-01`, to: `${key}-${pad(last)}` };
  }
  if (granularity === 'YEAR') return { from: `${key}-01-01`, to: `${key}-12-31` };
  const [year, week] = key.split('-W').map(Number) as [number, number];
  if (week < 1 || week > 53) throw new RangeError(`"${key}" is not an ISO week.`);
  // 4 January is always in ISO week 1, so the Monday of week 1 is the start of that week.
  const first = mondayOf(new Date(Date.UTC(year, 0, 4)));
  first.setUTCDate(first.getUTCDate() + (week - 1) * 7);
  const last = new Date(first.getTime());
  last.setUTCDate(last.getUTCDate() + 6);
  return { from: iso(first), to: iso(last) };
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function bucketLabel(key: string, granularity: Granularity): string {
  if (granularity === 'MONTH') {
    const [year, month] = key.split('-').map(Number) as [number, number];
    return `${MONTH_NAMES[month - 1]} ${year}`;
  }
  if (granularity === 'YEAR') return key;
  const bounds = bucketBounds(key, granularity);
  const short = (date: string) => { const [, month, day] = date.split('-').map(Number) as [number, number, number]; return `${day} ${MONTH_SHORT[month - 1]}`; };
  return granularity === 'DAY' ? `${short(key)} ${key.slice(0, 4)}` : `Week of ${short(bounds.from)} – ${short(bounds.to)} ${key.slice(0, 4)}`;
}

/** Every bucket a range touches, in order. A range is bounded, so this is cheap. */
export function periodBuckets(from: string, to: string, granularity: Granularity): { key: string; label: string }[] {
  const keys: string[] = [];
  const last = parseDate(to).getTime();
  for (let time = parseDate(from).getTime(); time <= last; time += DAY) {
    const key = bucketKey(iso(new Date(time)), granularity);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys.map((key) => ({ key, label: bucketLabel(key, granularity) }));
}

/** The bucket size that suits the range, so a year of data does not become 365 rows. */
export function defaultGranularity(from: string, to: string): Granularity {
  const days = daysBetween(from, to);
  if (days <= 31) return 'DAY';
  if (days <= 120) return 'WEEK';
  return 'MONTH';
}

// -------------------------------------------------------------- requests

export const ReportQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  granularity: Granularity.optional(),
  dimension: Dimension.optional(),
  collectorId: z.uuid().optional(),
  areaId: z.uuid().optional(),
  subscriberId: z.uuid().optional(),
}).strict().refine(
  (value) => !(value.from && value.to) || value.from <= value.to,
  { path: ['from'], message: 'The start date cannot be after the end date.' },
);
export type ReportQueryInput = z.input<typeof ReportQuery>;

export const ExportQuery = z.object({ format: ExportFormat }).strict();
export type ExportQueryInput = z.input<typeof ExportQuery>;

/**
 * The dashboard takes a date and nothing else. It is its own schema rather than a subset of
 * `ReportQuery`, because a report filter that silently does nothing on a dashboard is worse
 * than one that is refused: an owner who asks for last March should be told the dashboard
 * only answers for today, not shown this month.
 */
export const DashboardQuery = z.object({ to: IsoDate.optional() }).strict();
export type DashboardQueryInput = z.input<typeof DashboardQuery>;

/** One day by default, one month of days, or a whole month when the range is longer. */
export function resolvePeriod(raw: ReportQueryInput, today: string, snapshot = false): { from: string; to: string; granularity: Granularity } {
  const to = raw.to ?? today;
  if (snapshot) return { from: raw.from ?? to, to, granularity: raw.granularity ?? 'MONTH' };
  const from = raw.from ?? `${to.slice(0, 7)}-01`;
  return { from: from > to ? to : from, to, granularity: raw.granularity ?? defaultGranularity(from, to) };
}

/** An export is bounded, and says so, rather than producing a silently cut file. */
export const exportRowLimit = 5000;

// -------------------------------------------------------------- dashboard

/**
 * A KPI is a single headline figure with the count it is made of, so "PHP 48,200.00 across
 * 61 receipts" is one tile rather than two that can disagree. `tone` is a suggestion only:
 * the renderer shows text as well as colour, because colour alone is not an accessible
 * status indicator.
 */
export const KpiSchema = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  valueCentavos: money,
  count: z.number().int().min(0),
  hint: z.string().max(200),
  tone: z.enum(['neutral', 'good', 'warn', 'danger']),
});
export type Kpi = z.infer<typeof KpiSchema>;

export const DashboardSchema = z.object({
  asOf: IsoDate,
  generatedAt: z.string(),
  /** The month the collection and billing KPIs are measured over. */
  monthLabel: z.string(),
  monthStart: IsoDate,
  monthEnd: IsoDate,
  kpis: z.array(KpiSchema),
  billingVsCollection: z.array(z.object({ period: z.string(), label: z.string(), billedCentavos: money, collectedCentavos: money })),
  paymentMethods: z.array(z.object({ method: z.string(), receipts: z.number().int().min(0), collectedCentavos: money })),
  aging: z.array(z.object({ bucket: AgingBucket, label: z.string(), invoiceCount: z.number().int().min(0), accountCount: z.number().int().min(0), totalCentavos: money })),
  /**
   * Every open balance as of `asOf`, so the aging panel has a heading figure that came from the
   * same query as the buckets. The renderer displays this; it never adds the buckets itself.
   */
  receivableTotalCentavos: money,
  collectors: z.array(z.object({
    collectorCode: z.string(), collectorName: z.string(), accounts: z.number().int().min(0),
    expectedCashCentavos: money, collectedCashCentavos: money, remittedCentavos: money, varianceCentavos: z.number().int(),
  })),
  recentPayments: z.array(z.object({
    id: z.uuid(), receiptNumber: z.string().nullable(), method: z.string(), status: z.string(),
    receivedOn: IsoDate, amountCentavos: money, subscriberCode: z.string(), subscriberName: z.string(), recordedName: z.string(),
  })),
  overdueAlerts: z.array(z.object({
    serviceAccountId: z.uuid(), subscriberCode: z.string(), subscriberName: z.string(), planName: z.string(),
    areaName: z.string(), collectorName: z.string(), arrearsCentavos: money, overdueDays: z.number().int().min(0), bucket: AgingBucket,
  })),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

// -------------------------------------------------------------- display helpers

/**
 * The only place centavos become a peso string. Splitting the digits by hand keeps the
 * conversion exact: no division that could produce 99.99999999 for 9999.99.
 */
export function formatMoneyCell(value: ReportCell, withCurrency = true): string {
  if (typeof value !== 'number') return value === null || value === undefined ? '' : String(value);
  const digits = decimalMoney(value).replace('-', '');
  const [whole, fraction = ''] = digits.split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const text = `${value < 0 ? '-' : ''}${grouped}.${fraction}`;
  return withCurrency ? `PHP ${text}` : text;
}

export function formatCell(value: ReportCell, column: ReportColumn): string {
  if (value === null || value === undefined) return '';
  if (column.kind === 'MONEY') return formatMoneyCell(value);
  if (column.kind === 'NUMBER') return typeof value === 'number' ? value.toLocaleString('en-GB') : String(value);
  return String(value);
}

/**
 * A file name that sorts sensibly and can never escape a directory.
 *
 * The code comes from a fixed catalogue and the dates are validated ISO dates, so the span
 * is already safe by the time it arrives. It is filtered anyway: a suggestion that only holds
 * while every caller behaves is not a guarantee, and this string ends up on the desktop's
 * native save dialog, where a separator would change which folder the file lands in.
 */
export function reportFileName(code: ReportCode, from: string, to: string, format: ExportFormat): string {
  const name = code.toLowerCase().replace(/_/g, '-');
  const extension = format.toLowerCase();
  const safe = (value: string) => value.replace(/[^0-9-]+/g, '');
  // Only an already-clean ISO date keeps the span. Anything else loses it rather than being
  // passed through, so this string cannot carry a separator, a drive letter or a "..".
  const start = safe(from);
  const end = safe(to);
  const span = start === from && end === to ? (from === to ? from : `${from}_to_${to}`) : '';
  return `BCIS-${name}${span ? `-${span}` : ''}.${extension}`;
}