import {
  DashboardQuery, ReportQuery, assertBalanced, bucketLabel, reconcileAll, reportCatalogue, reportCodes, reportTitle, resolvePeriod, sumColumn,
  type Dashboard, type Dimension, type Granularity, type Kpi, type Reconciliation, type ReportCell, type ReportColumn, type ReportCode,
  type ReportQueryInput, type ReportRow, type ReportSubject, type ReportTable, type ReportTotal,
} from '../../shared/reports';
import { agingBucket, agingBucketLabels } from '../../shared/receivables';
import { ApiError } from '../auth/errors';
import type { AuthService } from '../auth/service';
import { parse } from '../master-data/service';

type Row = Record<string, unknown>;
type Permission = 'dashboard.view' | 'report.view' | 'report.export';

/** The SQL pattern each granularity groups a date by. Chosen from a closed enum, never from input. */
const bucketFormat: Record<Granularity, string> = { DAY: 'YYYY-MM-DD', WEEK: 'IYYY-"W"IW', MONTH: 'YYYY-MM', YEAR: 'YYYY' };

/**
 * PostgreSQL's ISO week (`IYYY`/`IW`) is exactly what `bucketKey` reproduces, so the
 * periods a report groups by and the periods `periodBuckets` predicts are the same
 * periods. The integration test compares the two rather than asking anyone to believe it.
 */
const bucketOf = (column: string, granularity: Granularity) => `to_char(${column},'${bucketFormat[granularity]}')`;

const today = () => new Date().toISOString().slice(0, 10);

/** The predicate that makes an invoice money someone still owes. Takes the alias so a report can apply it to its own rows. */
const openInvoice = (alias: string) => `${alias}.status IN ('UNPAID','PARTIALLY_PAID','OVERDUE') AND ${alias}.balance_centavos>0`;
const money = (centavos: number): number => centavos;
const cell = (value: unknown): ReportCell => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
};

const column = (key: string, label: string, kind: ReportColumn['kind'], width?: number, runningTotal = false): ReportColumn => ({
  key, label, kind, align: kind === 'TEXT' || kind === 'STATUS' || kind === 'DATE' ? 'LEFT' : 'RIGHT', width, runningTotal,
});

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** A blank report under construction. Every builder fills columns, rows and totals. */
const blankTable = (code: ReportCode, period: { from: string; to: string }, actor: { displayName: string }) => ({
  code,
  title: reportTitle(code),
  description: reportCatalogue[code].description,
  periodLabel: `${period.from} to ${period.to}`,
  from: period.from,
  to: period.to,
  asOf: reportCatalogue[code].snapshot ? period.to : null,
  // Null until a report knows it is about one account, which only a statement is.
  subject: null as ReportSubject | null,
  generatedAt: new Date().toISOString(),
  generatedBy: actor.displayName,
  columns: [] as ReportColumn[],
  rows: [] as ReportRow[],
  totals: [] as ReportTotal[],
  reconciliations: [] as Reconciliation[],
  footnote: '',
  truncated: false,
  rowCount: 0,
});

/**
 * Phase 8: management reports and the dashboard.
 *
 * Every figure is derived. There is no report table, no cache and no scheduled job, so a
 * report can never drift away from the invoices and payments it claims to summarise. Every
 * money column is reconciled against its stated total before the response leaves, and a
 * report that does not add up is refused rather than published.
 *
 * Where the rows are grouped by a dimension and the total comes from a second, ungrouped
 * query, the reconciliation is a genuine cross-check between two code paths rather than a
 * tautology.
 */
export class ReportsService {
  constructor(private auth: AuthService) {}

  private actor(token: string, permission: Permission) { return this.auth.authorize(token, permission); }

  /** The catalogue comes from the server, so the desktop cannot offer a report that does not exist. */
  async catalogue(token: string) {
    const actor = await this.actor(token, 'report.view');
    return {
      generatedAt: new Date().toISOString(),
      reports: reportCodes().map((code) => ({ ...reportCatalogue[code], exportable: actor.permissions.includes('report.export') })),
    };
  }

  private publish(table: ReturnType<typeof blankTable>, footnote: string, rowCount?: number): ReportTable {
    table.reconciliations = assertBalanced(reconcileAll(table.columns, table.rows, table.totals));
    table.footnote = footnote;
    table.rowCount = rowCount ?? table.rows.length;
    return table as ReportTable;
  }

  async build(token: string, code: ReportCode, raw: unknown): Promise<ReportTable> {
    const actor = await this.actor(token, 'report.view');
    const input = parse(ReportQuery, raw);
    const definition = reportCatalogue[code];
    const period = resolvePeriod(input, today(), definition.snapshot);
    const table = blankTable(code, period, actor);
    switch (code) {
      case 'COLLECTIONS': return this.collections(table, input, period);
      case 'BILLING_VS_COLLECTION': return this.billingVsCollection(table, input, period);
      case 'REVENUE': return this.revenue(table, input, period);
      case 'AR_AGING': return this.arAging(table, period);
      case 'SUBSCRIBER_LEDGER': return this.statementOfAccount(table, input, period);
      case 'SUBSCRIBER_MASTER': return this.subscriberMaster(table, input);
      case 'COLLECTOR_PERFORMANCE': return this.collectorPerformance(table, input, period);
      case 'PAYMENT_EXCEPTIONS': return this.paymentExceptions(table, period);
      case 'AUDIT_TRAIL': return this.auditTrail(table, period);
    }
  }

  // -------------------------------------------------------------- collections

  /**
   * Collections by period and method. One query answers the daily, weekly, monthly and
   * annual collection reports and the Cash/GCash summary, because changing the bucket is the
   * only difference between them.
   *
   * Collected counts a receipt once, in the period it was received. Money sitting as
   * unspent customer credit is reported in its own column rather than counted twice.
   */
  private async collections(table: ReturnType<typeof blankTable>, input: ReportQueryInput, period: { from: string; to: string; granularity: Granularity }) {
    const { from, to, granularity } = period;
    const rows = (await this.auth.pool.query(
      `SELECT ${bucketOf('p.received_on', granularity)} AS period,p.method,count(*)::int AS receipts,
         coalesce(sum(p.amount_centavos),0)::bigint AS collected,
         coalesce(sum(p.amount_centavos-coalesce(alloc.applied,0)),0)::bigint AS advance
       FROM payments p
       LEFT JOIN LATERAL (SELECT sum(a.amount_centavos) AS applied FROM payment_allocations a
         WHERE a.payment_id=p.id AND a.reversed_at IS NULL) alloc ON true
       WHERE p.status='POSTED' AND p.direction='PAYMENT' AND p.received_on BETWEEN $1::date AND $2::date
         AND EXISTS (SELECT 1 FROM service_accounts sa WHERE sa.subscriber_id=p.subscriber_id
           AND ($3::uuid IS NULL OR sa.collector_id=$3::uuid) AND ($4::uuid IS NULL OR sa.area_id=$4::uuid))
       GROUP BY 1,p.method ORDER BY 1,p.method`,
      [from, to, input.collectorId ?? null, input.areaId ?? null],
    )).rows as Row[];
    table.columns = [
      column('periodLabel', 'Period', 'TEXT', 26),
      column('method', 'Method', 'STATUS', 12),
      column('receipts', 'Receipts', 'NUMBER', 10),
      column('collectedCentavos', 'Collected', 'MONEY', 20),
      column('advanceCentavos', 'Customer credit held', 'MONEY', 22),
    ];
    table.rows = rows.map((row) => ({
      periodKey: String(row.period),
      periodLabel: bucketLabel(String(row.period), granularity),
      method: String(row.method),
      receipts: Number(row.receipts),
      collectedCentavos: money(Number(row.collected)),
      advanceCentavos: money(Number(row.advance)),
    }));
    table.totals = [{
      label: 'Total collected',
      values: {
        receipts: rows.reduce((total, row) => total + Number(row.receipts), 0),
        collectedCentavos: sumColumn(table.rows, 'collectedCentavos'),
        advanceCentavos: sumColumn(table.rows, 'advanceCentavos'),
      },
      emphasis: true,
    }];
    return this.publish(table, 'Collected counts each posted receipt once, in the period it was received. Customer credit held is collected money not yet applied to an invoice.');
  }

  // -------------------------------------------------------------- billing vs collection

  /**
   * Billed against collected for each period. Billed is the total of the invoices issued in
   * the period and collected is the cash received in it, so the difference is a cash
   * position rather than a debt: a period that collects an old arrears bill legitimately
   * shows as collecting more than it billed.
   */
  private async billingVsCollection(table: ReturnType<typeof blankTable>, input: ReportQueryInput, period: { from: string; to: string; granularity: Granularity }) {
    const { from, to, granularity } = period;
    const collectorId = input.collectorId ?? null;
    const areaId = input.areaId ?? null;
    const rows = (await this.auth.pool.query(
      `WITH billed AS (
         SELECT ${bucketOf('i.issue_date', granularity)} AS period,count(*)::int AS invoices,
           coalesce(sum(i.total_centavos),0)::bigint AS billed
         FROM invoices i JOIN service_accounts sa ON sa.id=i.service_account_id
         WHERE i.status NOT IN ('DRAFT','VOID') AND i.issue_date BETWEEN $1::date AND $2::date
           AND ($3::uuid IS NULL OR sa.collector_id=$3::uuid) AND ($4::uuid IS NULL OR sa.area_id=$4::uuid)
         GROUP BY 1),
       collected AS (
         SELECT ${bucketOf('p.received_on', granularity)} AS period,coalesce(sum(p.amount_centavos),0)::bigint AS collected
         FROM payments p
         WHERE p.status='POSTED' AND p.direction='PAYMENT' AND p.received_on BETWEEN $1::date AND $2::date
           AND EXISTS (SELECT 1 FROM service_accounts a WHERE a.subscriber_id=p.subscriber_id
             AND ($3::uuid IS NULL OR a.collector_id=$3::uuid) AND ($4::uuid IS NULL OR a.area_id=$4::uuid))
         GROUP BY 1)
       SELECT coalesce(b.period,c.period) AS period,coalesce(b.invoices,0)::int AS invoices,
         coalesce(b.billed,0)::int AS billed,coalesce(c.collected,0)::int AS collected
       FROM billed b FULL OUTER JOIN collected c ON c.period=b.period ORDER BY 1`,
      [from, to, collectorId, areaId],
    )).rows as Row[];
    table.columns = [
      column('periodLabel', 'Period', 'TEXT', 26),
      column('invoices', 'Invoices issued', 'NUMBER', 14),
      column('billedCentavos', 'Billed', 'MONEY', 20),
      column('collectedCentavos', 'Collected', 'MONEY', 20),
      column('differenceCentavos', 'Difference (collected less billed)', 'MONEY', 26),
    ];
    table.rows = rows.map((row) => {
      const billed = Number(row.billed);
      const collected = Number(row.collected);
      return {
        periodKey: String(row.period),
        periodLabel: bucketLabel(String(row.period), granularity),
        invoices: Number(row.invoices),
        billedCentavos: money(billed),
        collectedCentavos: money(collected),
        differenceCentavos: money(collected - billed),
      };
    });
    const billed = sumColumn(table.rows, 'billedCentavos');
    const collected = sumColumn(table.rows, 'collectedCentavos');
    table.totals = [{
      label: 'Period totals',
      values: {
        invoices: rows.reduce((total, row) => total + Number(row.invoices), 0),
        billedCentavos: billed,
        collectedCentavos: collected,
        differenceCentavos: money(collected - billed),
      },
      emphasis: true,
    }];
    return this.publish(table, 'Billed is the total of invoices issued in the period; collected is cash received in it. A negative difference is cash not yet collected.');
  }

  // -------------------------------------------------------------- revenue

  /**
   * Revenue by plan, service type or collection area. Collected revenue is the share of
   * posted receipts applied to invoices, so money still held as customer credit is not
   * attributed to a plan until it is spent. The stated total comes from an ungrouped query,
   * which makes the reconciliation a real cross-check.
   */
  private async revenue(table: ReturnType<typeof blankTable>, input: ReportQueryInput, period: { from: string; to: string }) {
    const { from, to } = period;
    const dimension: Dimension = input.dimension ?? 'PLAN';
    const key = dimension === 'PLAN' ? 'p.code' : dimension === 'SERVICE_TYPE' ? 'p.service_type' : "coalesce(ca.name,'Unassigned')";
    const label = dimension === 'SERVICE_TYPE' ? "initcap(p.service_type)" : "coalesce(p.name,ca.name,'Unassigned')";
    const scope = `($3::uuid IS NULL OR sa.collector_id=$3::uuid) AND ($4::uuid IS NULL OR sa.area_id=$4::uuid)`;
    const from_ = `FROM payment_allocations a
       JOIN payments pay ON pay.id=a.payment_id
       JOIN invoices i ON i.id=a.invoice_id
       JOIN service_accounts sa ON sa.id=i.service_account_id
       JOIN service_plans p ON p.id=sa.plan_id
       LEFT JOIN collection_areas ca ON ca.id=sa.area_id
       WHERE a.reversed_at IS NULL AND pay.status='POSTED' AND pay.direction='PAYMENT'
         AND pay.received_on BETWEEN $1::date AND $2::date AND ${scope}`;
    const values = [from, to, input.collectorId ?? null, input.areaId ?? null];
    const billedRows = (await this.auth.pool.query(
      `SELECT ${key} AS key,${label} AS label,count(DISTINCT i.service_account_id)::int AS services,
         count(*)::int AS invoices,coalesce(sum(i.total_centavos),0)::bigint AS billed
       FROM invoices i
       JOIN service_accounts sa ON sa.id=i.service_account_id
       JOIN service_plans p ON p.id=sa.plan_id
       LEFT JOIN collection_areas ca ON ca.id=sa.area_id
       WHERE i.status NOT IN ('DRAFT','VOID') AND i.issue_date BETWEEN $1::date AND $2::date AND ${scope}
       GROUP BY 1,2 ORDER BY 1`, values,
    )).rows as Row[];
    const collectedRows = (await this.auth.pool.query(`SELECT ${key} AS key,coalesce(sum(a.amount_centavos),0)::bigint AS collected ${from_} GROUP BY 1`, values)).rows as Row[];
    const grandCollected = Number((await this.auth.pool.query(`SELECT coalesce(sum(a.amount_centavos),0)::bigint AS collected ${from_}`, values)).rows[0]!.collected);
    const collected = new Map(collectedRows.map((row) => [String(row.key), Number(row.collected)]));
    table.columns = [
      column('dimension', dimension === 'PLAN' ? 'Plan' : dimension === 'SERVICE_TYPE' ? 'Service type' : 'Collection area', 'TEXT', 30),
      column('services', 'Services', 'NUMBER', 10),
      column('invoices', 'Invoices', 'NUMBER', 10),
      column('billedCentavos', 'Billed', 'MONEY', 20),
      column('collectedCentavos', 'Collected (applied)', 'MONEY', 22),
    ];
    table.rows = billedRows.map((row) => ({
      dimensionKey: String(row.key),
      dimension: String(row.label),
      services: Number(row.services),
      invoices: Number(row.invoices),
      billedCentavos: money(Number(row.billed)),
      collectedCentavos: money(collected.get(String(row.key)) ?? 0),
    }));
    table.totals = [{
      label: 'Totals',
      values: {
        services: sumColumn(table.rows, 'services'),
        invoices: sumColumn(table.rows, 'invoices'),
        billedCentavos: sumColumn(table.rows, 'billedCentavos'),
        collectedCentavos: grandCollected,
      },
      emphasis: true,
    }];
    return this.publish(table, `Grouped by ${dimension.toLowerCase().replace('_', ' ')}. Collected is the share of posted receipts applied to invoices in the period, so unspent customer credit is not attributed here.`);
  }

  // -------------------------------------------------------------- aging

  /**
   * Receivables today, in the five published buckets. This is deliberately a second
   * implementation of the Phase 7 aging: the integration test asserts the two agree for the
   * same day, which is what allows the dashboard to be built without handing a cashier the
   * receivables worklist and still be certain the two paths agree.
   */
  private async arAging(table: ReturnType<typeof blankTable>, period: { from: string; to: string }) {
    const asOf = period.to;
    const boundaries = await this.agingBuckets(asOf, 'i');
    table.columns = [
      column('bucketLabel', 'Aging bucket', 'TEXT', 26),
      column('invoiceCount', 'Open invoices', 'NUMBER', 14),
      column('accountCount', 'Service accounts', 'NUMBER', 16),
      column('amountCentavos', 'Outstanding', 'MONEY', 22),
    ];
    table.rows = boundaries.map((entry) => ({
      bucket: entry.bucket,
      bucketLabel: agingBucketLabels[entry.bucket],
      invoiceCount: entry.invoiceCount,
      accountCount: entry.accountCount,
      amountCentavos: money(entry.totalCentavos),
    }));
    table.totals = [{
      label: `Total receivable as at ${asOf}`,
      values: {
        invoiceCount: boundaries.reduce((total, entry) => total + entry.invoiceCount, 0),
        amountCentavos: sumColumn(table.rows, 'amountCentavos'),
      },
      emphasis: true,
    }];
    return this.publish(table, `A snapshot of ${asOf}: open, unpaid invoice balances only, grouped into the five published aging buckets.`);
  }

  /**
   * The five buckets with their invoice and account counts. The SQL boundaries are the
   * mirror of `agingBucket`, and the unit tests pin both sides, so the report and the
   * receivables screen cannot disagree about which band an invoice falls in.
   */
  private async agingBuckets(asOf: string, alias: string) {
    const rows = (await this.auth.pool.query(
      `SELECT (CASE WHEN ${alias}.due_date >= $1::date THEN 'CURRENT'
             WHEN ${alias}.due_date > $1::date-30 THEN 'D1_30'
             WHEN ${alias}.due_date > $1::date-60 THEN 'D31_60'
             WHEN ${alias}.due_date > $1::date-90 THEN 'D61_90'
             ELSE 'D90_PLUS' END) AS bucket,
         count(*)::int AS invoices,count(DISTINCT ${alias}.service_account_id)::int AS accounts,
         coalesce(sum(${alias}.balance_centavos),0)::bigint AS amount
       FROM invoices ${alias} WHERE ${openInvoice(alias)} GROUP BY 1`, [asOf],
    )).rows as Row[];
    const found = new Map(rows.map((row) => [String(row.bucket), row]));
    const order: AgingBucketKey[] = ['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS'];
    return order.map((bucket) => {
      const row = found.get(bucket);
      return { bucket, invoiceCount: Number(row?.invoices ?? 0), accountCount: Number(row?.accounts ?? 0), totalCentavos: Number(row?.amount ?? 0) };
    });
  }

  // -------------------------------------------------------------- statement of account

  /**
   * One subscriber's statement for a date range. Debits and credits reconcile against the
   * ledger entries themselves, and the opening balance plus the period's movement must land
   * on the closing balance, which is the statement's own arithmetic.
   */
  private async statementOfAccount(table: ReturnType<typeof blankTable>, input: ReportQueryInput, period: { from: string; to: string }) {
    if (!input.subscriberId) throw new ApiError(422, 'VALIDATION', 'Choose a subscriber to produce a statement of account.', { subscriberId: ['Choose a subscriber.'] });
    const { from, to } = period;
    const subscriber = (await this.auth.pool.query(
      `SELECT s.code,s.name,s.contact FROM subscribers s WHERE s.id=$1`, [input.subscriberId],
    )).rows[0] as Row | undefined;
    if (!subscriber) throw new ApiError(404, 'NOT_FOUND', 'That subscriber does not exist.');
    // The statement is handed to one person, so the account it belongs to is printed on it.
    // Without this the PDF and the spreadsheet are a ledger extract with no owner on the page.
    table.subject = {
      label: 'Statement of account for',
      fields: [
        { label: 'Account', value: String(subscriber.code) },
        { label: 'Subscriber', value: String(subscriber.name) },
        { label: 'Contact', value: String(subscriber.contact ?? '—') },
      ],
    };
    const rows = (await this.auth.pool.query(
      `SELECT to_char(le.entry_date,'YYYY-MM-DD') AS entry_date,le.entry_no,le.reference_type,le.reference_number,le.description,
         le.debit_centavos,le.credit_centavos,le.balance_centavos
       FROM ledger_entries le
       WHERE le.subscriber_id=$1 AND le.entry_date BETWEEN $2::date AND $3::date
       ORDER BY le.entry_date,le.entry_no`, [input.subscriberId, from, to],
    )).rows as Row[];
    table.columns = [
      column('entryDate', 'Date', 'DATE', 12),
      column('reference', 'Reference', 'TEXT', 18),
      column('description', 'Description', 'TEXT', 44),
      column('debitCentavos', 'Debit', 'MONEY', 16),
      column('creditCentavos', 'Credit', 'MONEY', 16),
      // A running balance, not an amount: summing it would compare a total with a sum of
      // balances, so it is excluded from the reconciliation and checked by the arithmetic
      // above instead.
      column('balanceCentavos', 'Balance', 'MONEY', 18, true),
    ];
    table.rows = rows.map((row) => ({
      entryDate: String(row.entry_date),
      reference: String(row.reference_number ?? '—'),
      description: `${String(row.reference_type).toLowerCase()} · ${row.description}`,
      debitCentavos: money(Number(row.debit_centavos)),
      creditCentavos: money(Number(row.credit_centavos)),
      balanceCentavos: money(Number(row.balance_centavos)),
    }));
    // The stored balance is reproduced from the entry itself rather than trusted, so a
    // tampered running balance would surface here instead of on a printed statement.
    const opening = rows.length > 0
      ? Number(rows[0]!.balance_centavos) - Number(rows[0]!.debit_centavos) + Number(rows[0]!.credit_centavos)
      : 0;
    let running = opening;
    for (const row of rows) {
      running += Number(row.debit_centavos) - Number(row.credit_centavos);
      if (running !== Number(row.balance_centavos)) throw new Error(`Statement of account running balance does not reproduce at ${String(row.entry_date)}.`);
    }
    table.totals = [
      { label: `Opening balance at ${from}`, values: { balanceCentavos: money(opening) }, emphasis: false },
      { label: 'Period movement', values: { debitCentavos: sumColumn(table.rows, 'debitCentavos'), creditCentavos: sumColumn(table.rows, 'creditCentavos') }, emphasis: false },
      { label: `Closing balance at ${to}`, values: { balanceCentavos: money(running) }, emphasis: true },
    ];
    return this.publish(table, `${subscriber.code} · ${subscriber.name}${subscriber.contact ? ` · ${subscriber.contact}` : ''}. Every line is a posted ledger entry; a voided or reversed document appears as its own reversal rather than disappearing.`);
  }

  // -------------------------------------------------------------- subscriber master

  private async subscriberMaster(table: ReturnType<typeof blankTable>, input: ReportQueryInput) {
    const rows = (await this.auth.pool.query(
      `SELECT s.code,s.name,s.contact,s.status,
         count(DISTINCT sa.id)::int AS services,
         coalesce((SELECT sum(i.balance_centavos) FROM invoices i
           WHERE i.subscriber_id=s.id AND i.status IN ('UNPAID','PARTIALLY_PAID','OVERDUE')),0)::int AS outstanding
       FROM subscribers s
       LEFT JOIN service_accounts sa ON sa.subscriber_id=s.id
         AND ($1::uuid IS NULL OR sa.collector_id=$1::uuid) AND ($2::uuid IS NULL OR sa.area_id=$2::uuid)
       GROUP BY s.id ORDER BY s.code`, [input.collectorId ?? null, input.areaId ?? null],
    )).rows as Row[];
    table.columns = [
      column('code', 'Account number', 'TEXT', 16),
      column('name', 'Subscriber', 'TEXT', 30),
      column('contact', 'Contact', 'TEXT', 18),
      column('status', 'Status', 'STATUS', 12),
      column('services', 'Service accounts', 'NUMBER', 14),
      column('outstandingCentavos', 'Outstanding', 'MONEY', 18),
    ];
    table.rows = rows.map((row) => ({
      code: String(row.code), name: String(row.name), contact: cell(row.contact), status: String(row.status),
      services: Number(row.services), outstandingCentavos: money(Number(row.outstanding)),
    }));
    table.totals = [{
      label: 'Totals',
      values: { services: sumColumn(table.rows, 'services'), outstandingCentavos: sumColumn(table.rows, 'outstandingCentavos') },
      emphasis: true,
    }];
    return this.publish(table, 'One row per subscriber. Outstanding is the open invoice balance at the moment this report ran.');
  }

  // -------------------------------------------------------------- collector performance

  /**
   * Collector accountability in one table: what they were assigned, what was expected of
   * them, what they banked and what they remitted. A shortage stays on the record here
   * rather than being netted away, which is the whole point of Phase 6.
   *
   * Each batch is rolled up on its own row before it reaches the collector, so a route with
   * forty accounts still contributes one batch's cash once rather than forty times.
   */
  private async collectorPerformance(table: ReturnType<typeof blankTable>, input: ReportQueryInput, period: { from: string; to: string }) {
    const rows = (await this.auth.pool.query(
      `WITH batch_roll AS (
         SELECT b.id,b.collector_id,
           (SELECT count(*)::int FROM batch_accounts x WHERE x.batch_id=b.id) AS accounts,
           coalesce((SELECT sum(r.expected_cash_centavos) FROM batch_remittances r WHERE r.batch_id=b.id),
             (SELECT coalesce(sum(x.total_due_centavos),0)::int FROM batch_accounts x WHERE x.batch_id=b.id))::int AS expected,
           (SELECT coalesce(sum(p.amount_centavos),0)::int FROM payments p
             WHERE p.collection_batch_id=b.id AND p.status='POSTED' AND p.direction='PAYMENT' AND p.method='CASH') AS collected,
           coalesce((SELECT sum(r.cash_centavos) FROM batch_remittances r WHERE r.batch_id=b.id),0)::int AS remitted,
           coalesce((SELECT sum(r.shortage_centavos) FROM batch_remittances r WHERE r.batch_id=b.id),0)::int AS shortage,
           coalesce((SELECT sum(r.overage_centavos) FROM batch_remittances r WHERE r.batch_id=b.id),0)::int AS overage
         FROM collection_batches b WHERE b.collection_date BETWEEN $1::date AND $2::date)
       SELECT cl.code,cl.name,cl.contact,
         coalesce(sum(br.accounts),0)::int AS accounts,coalesce(sum(br.expected),0)::bigint AS expected,
         coalesce(sum(br.collected),0)::bigint AS collected,coalesce(sum(br.remitted),0)::bigint AS remitted,
         coalesce(sum(br.shortage),0)::bigint AS shortage,coalesce(sum(br.overage),0)::bigint AS overage
       FROM collectors cl LEFT JOIN batch_roll br ON br.collector_id=cl.id
       WHERE ($3::uuid IS NULL OR cl.id=$3::uuid)
       GROUP BY cl.id ORDER BY cl.code`, [period.from, period.to, input.collectorId ?? null],
    )).rows as Row[];
    table.columns = [
      column('code', 'Collector', 'TEXT', 14),
      column('name', 'Name and contact', 'TEXT', 26),
      column('accounts', 'Accounts on routes', 'NUMBER', 16),
      column('expectedCashCentavos', 'Expected cash', 'MONEY', 20),
      column('collectedCashCentavos', 'Cash collected', 'MONEY', 20),
      column('remittedCentavos', 'Cash remitted', 'MONEY', 20),
      column('varianceCentavos', 'Difference (collected less remitted)', 'MONEY', 24),
      column('shortageCentavos', 'Shortage on record', 'MONEY', 18),
      column('overageCentavos', 'Overage on record', 'MONEY', 18),
    ];
    table.rows = rows.map((row) => ({
      code: String(row.code),
      name: `${row.name}${row.contact ? ` · ${row.contact}` : ''}`,
      accounts: Number(row.accounts),
      expectedCashCentavos: money(Number(row.expected)),
      collectedCashCentavos: money(Number(row.collected)),
      remittedCentavos: money(Number(row.remitted)),
      varianceCentavos: money(Number(row.collected) - Number(row.remitted)),
      shortageCentavos: money(Number(row.shortage)),
      overageCentavos: money(Number(row.overage)),
    }));
    const sum = (key: string) => sumColumn(table.rows, key);
    table.totals = [{
      label: 'Totals',
      values: {
        accounts: sum('accounts'), expectedCashCentavos: sum('expectedCashCentavos'), collectedCashCentavos: sum('collectedCashCentavos'),
        remittedCentavos: sum('remittedCentavos'), varianceCentavos: sum('varianceCentavos'),
        shortageCentavos: sum('shortageCentavos'), overageCentavos: sum('overageCentavos'),
      },
      emphasis: true,
    }];
    return this.publish(table, 'Expected cash is what the remittance was counted against, or the receivable frozen onto the route before it was counted. Collected cash counts posted cash receipts only: a claimed GCash payment is not cash in hand.');
  }

  // -------------------------------------------------------------- payment exceptions

  /**
   * The payments that are not ordinary: voided receipts, reversals and GCash claims still
   * waiting for a second person. Their combined value reconciles against the register, so a
   * report cannot quietly omit a large reversal.
   */
  private async paymentExceptions(table: ReturnType<typeof blankTable>, period: { from: string; to: string }) {
    const rows = (await this.auth.pool.query(
      `SELECT to_char(p.received_on,'YYYY-MM-DD') AS received_on,p.receipt_number,p.status,p.method,p.amount_centavos,p.direction,
         s.code AS subscriber_code,s.name AS subscriber_name,p.void_reason,p.reason
       FROM payments p JOIN subscribers s ON s.id=p.subscriber_id
       WHERE (p.status IN ('VOID','REVERSED','PENDING') OR p.direction='REVERSAL')
         AND p.received_on BETWEEN $1::date AND $2::date
       ORDER BY p.received_on DESC,p.receipt_number DESC`, [period.from, period.to],
    )).rows as Row[];
    table.columns = [
      column('receivedOn', 'Date', 'DATE', 12),
      column('receiptNumber', 'Receipt', 'TEXT', 18),
      column('subscriberCode', 'Account', 'TEXT', 14),
      column('subscriberName', 'Subscriber', 'TEXT', 26),
      column('category', 'Category', 'STATUS', 24),
      column('method', 'Method', 'STATUS', 10),
      column('amountCentavos', 'Amount', 'MONEY', 18),
      column('reason', 'Reason', 'TEXT', 40),
    ];
    table.rows = rows.map((row) => ({
      receivedOn: String(row.received_on),
      receiptNumber: cell(row.receipt_number),
      subscriberCode: String(row.subscriber_code),
      subscriberName: String(row.subscriber_name),
      // A reversal is a document of its own with its own receipt, so it is classified by its
      // direction rather than by a status that says only POSTED.
      category: row.direction === 'REVERSAL' ? 'Reversal' : row.status === 'PENDING' ? 'Awaiting verification' : row.status === 'VOID' ? 'Voided receipt' : String(row.status),
      method: String(row.method),
      amountCentavos: money(Number(row.amount_centavos)),
      reason: cell(row.void_reason || row.reason || '—'),
    }));
    table.totals = [{ label: 'Value of exceptions in period', values: { amountCentavos: sumColumn(table.rows, 'amountCentavos') }, emphasis: true }];
    return this.publish(table, 'Voided receipts and reversals keep their number and their history. A pending GCash claim is unverified and has not been posted.');
  }

  // -------------------------------------------------------------- audit trail

  private async auditTrail(table: ReturnType<typeof blankTable>, period: { from: string; to: string }) {
    const rows = (await this.auth.pool.query(
      `SELECT a.created_at,a.action,u.display_name AS actor,
         coalesce(a.details->>'reason',a.details->>'period',a.details->>'code',a.details->>'report','') AS detail
       FROM audit_logs a JOIN users u ON u.id=a.actor_id
       WHERE a.created_at >= $1::date AND a.created_at < ($2::date + 1)
       ORDER BY a.created_at DESC,a.id DESC LIMIT 5001`, [period.from, period.to],
    )).rows as Row[];
    table.columns = [
      column('occurredAt', 'When', 'TEXT', 22),
      column('actor', 'Actor', 'TEXT', 24),
      column('action', 'Action', 'TEXT', 34),
      column('detail', 'Detail', 'TEXT', 46),
    ];
    table.rows = rows.map((row) => ({
      occurredAt: String(row.created_at).replace('T', ' ').slice(0, 19),
      actor: String(row.actor),
      action: String(row.action),
      detail: cell(row.detail) || '—',
    }));
    // A bounded export says so. A silently cut file is worse than no file.
    if (table.rows.length > 5000) table.truncated = true;
    table.rows = table.rows.slice(0, 5000);
    return this.publish(table, table.truncated
      ? 'This audit extract reached its 5,000-row limit and is a partial view; narrow the date range for a complete export.'
      : 'Audit entries are append-only and cannot be edited or deleted through the application.', table.rows.length);
  }

  // -------------------------------------------------------------- dashboard

  /**
   * Six KPIs over the same queries the reports use, plus the panels an owner checks first.
   * The receivable figures are computed here under `dashboard.view` rather than read through
   * the receivables service, so a cashier sees what the office collected without being handed
   * the receivables worklist. The integration test asserts the two agree for the same day.
   */
  async dashboard(token: string, raw: unknown): Promise<Dashboard> {
    await this.actor(token, 'dashboard.view');
    const input = parse(DashboardQuery, raw ?? {});
    const asOf = input.to ?? today();
    const monthStart = `${asOf.slice(0, 7)}-01`;
    const open = openInvoice('i');
    const pool = this.auth.pool;
    const [month, receivable, buckets, trend, methods, collectors, recent, alerts] = await Promise.all([
      pool.query(
        `SELECT (SELECT coalesce(sum(p.amount_centavos),0)::bigint FROM payments p
            WHERE p.status='POSTED' AND p.direction='PAYMENT' AND p.received_on BETWEEN $1::date AND $2::date) AS collected,
           (SELECT count(*)::int FROM payments p
            WHERE p.status='POSTED' AND p.direction='PAYMENT' AND p.received_on BETWEEN $1::date AND $2::date) AS receipts,
           (SELECT coalesce(sum(i.total_centavos),0)::bigint FROM invoices i
            WHERE i.status NOT IN ('DRAFT','VOID') AND i.issue_date BETWEEN $1::date AND $2::date) AS billed,
           (SELECT count(*)::int FROM invoices i
            WHERE i.status NOT IN ('DRAFT','VOID') AND i.issue_date BETWEEN $1::date AND $2::date) AS invoices`,
        [monthStart, asOf],
      ),
      pool.query(
        // The account count is its own query rather than a correlated subquery: reusing the
        // outer predicate inside one would read an ungrouped column and PostgreSQL is right
        // to refuse it.
        `SELECT coalesce(sum(i.balance_centavos) FILTER (WHERE i.due_date>=$1::date),0)::bigint AS current_sum,
           coalesce(sum(i.balance_centavos) FILTER (WHERE i.due_date<$1::date),0)::bigint AS arrears_sum,
           coalesce(sum(i.balance_centavos),0)::bigint AS total_sum,
           count(*) FILTER (WHERE i.due_date<$1::date)::int AS overdue_invoices,
           count(DISTINCT i.subscriber_id) FILTER (WHERE i.due_date<$1::date)::int AS overdue_subscribers,
           (SELECT count(DISTINCT x.service_account_id)::int FROM invoices x
             WHERE ${openInvoice('x')}) AS accounts
         FROM invoices i WHERE ${open}`, [asOf],
      ),
      this.agingBuckets(asOf, 'i'),
      pool.query(
        `WITH months AS (SELECT to_char(d,'YYYY-MM') AS period FROM generate_series(
             (date_trunc('month',$1::date) - interval '5 months')::date,
             date_trunc('month',$1::date)::date, interval '1 month') d)
         SELECT m.period,
           coalesce((SELECT sum(i.total_centavos) FROM invoices i
             WHERE i.status NOT IN ('DRAFT','VOID') AND to_char(i.issue_date,'YYYY-MM')=m.period),0)::bigint AS billed,
           coalesce((SELECT sum(p.amount_centavos) FROM payments p
             WHERE p.status='POSTED' AND p.direction='PAYMENT' AND to_char(p.received_on,'YYYY-MM')=m.period),0)::bigint AS collected
         FROM months m ORDER BY m.period`, [asOf],
      ),
      pool.query(
        `SELECT method,count(*)::int AS receipts,coalesce(sum(amount_centavos),0)::bigint AS collected
         FROM payments WHERE status='POSTED' AND direction='PAYMENT' AND received_on BETWEEN $1::date AND $2::date
         GROUP BY method ORDER BY method`, [monthStart, asOf],
      ),
      pool.query(
        `WITH batch_roll AS (
           SELECT b.collector_id,
             (SELECT coalesce(sum(p.amount_centavos),0)::int FROM payments p
               WHERE p.collection_batch_id=b.id AND p.status='POSTED' AND p.direction='PAYMENT' AND p.method='CASH') AS collected,
             coalesce((SELECT sum(r.cash_centavos) FROM batch_remittances r WHERE r.batch_id=b.id),0)::int AS remitted
           FROM collection_batches b)
         SELECT cl.code,cl.name,cl.contact,
           (SELECT count(*)::int FROM service_accounts sa WHERE sa.collector_id=cl.id) AS accounts,
           coalesce(sum(br.collected),0)::bigint AS collected,coalesce(sum(br.remitted),0)::bigint AS remitted
         FROM collectors cl LEFT JOIN batch_roll br ON br.collector_id=cl.id GROUP BY cl.id ORDER BY cl.code`,
      ),
      pool.query(
        `SELECT p.id,p.receipt_number,p.method,p.status,to_char(p.received_on,'YYYY-MM-DD') AS received_on,p.amount_centavos,
           s.code AS subscriber_code,s.name AS subscriber_name,u.display_name AS recorded_name
         FROM payments p JOIN subscribers s ON s.id=p.subscriber_id JOIN users u ON u.id=p.recorded_by
         WHERE p.status IN ('POSTED','PENDING') ORDER BY p.received_on DESC,p.created_at DESC LIMIT 8`,
      ),
      pool.query(
        `SELECT sa.id,s.code,s.name,p.name AS plan_name,coalesce(ca.name,'') AS area_name,coalesce(cl.name,'') AS collector_name,
           sum(i.balance_centavos)::int AS arrears,to_char(min(i.due_date),'YYYY-MM-DD') AS oldest_due
         FROM service_accounts sa
         JOIN subscribers s ON s.id=sa.subscriber_id
         JOIN service_plans p ON p.id=sa.plan_id
         LEFT JOIN collection_areas ca ON ca.id=sa.area_id
         LEFT JOIN collectors cl ON cl.id=sa.collector_id
         JOIN invoices i ON i.service_account_id=sa.id AND i.status IN ('UNPAID','PARTIALLY_PAID','OVERDUE') AND i.balance_centavos>0
         WHERE i.due_date<$1::date
         GROUP BY sa.id,s.code,s.name,p.name,ca.name,cl.name
         ORDER BY min(i.due_date),sum(i.balance_centavos) DESC LIMIT 5`, [asOf],
      ),
    ]);
    const monthRow = month.rows[0] as Row;
    const receivableRow = receivable.rows[0] as Row;
    const collected = Number(monthRow.collected);
    const billed = Number(monthRow.billed);
    const current = Number(receivableRow.current_sum);
    const arrears = Number(receivableRow.arrears_sum);
    const overdueSubscribers = Number(receivableRow.overdue_subscribers);
    const followUp = buckets.filter((entry) => entry.bucket !== 'CURRENT').reduce((total, entry) => total + entry.accountCount, 0);
    // The buckets and the receivable total are two views of the same open invoices, so they are
    // added up here rather than in the screen. If they ever disagree the screen would be showing
    // a total that contradicts its own rows, which is why this is checked instead of trusted.
    const receivableTotal = Number(receivableRow.total_sum);
    const bucketedTotal = buckets.reduce((total, entry) => total + entry.totalCentavos, 0);
    if (bucketedTotal !== receivableTotal) {
      throw new Error(`dashboard aging buckets total ${bucketedTotal} but the open receivable total is ${receivableTotal} as of ${asOf}`);
    }
    const kpis: Kpi[] = [
      { key: 'collected', label: 'Collected this month', valueCentavos: collected, count: Number(monthRow.receipts), hint: 'Posted receipts received this month', tone: 'good' },
      { key: 'billed', label: 'Billed this month', valueCentavos: billed, count: Number(monthRow.invoices), hint: 'Invoices issued this month', tone: 'neutral' },
      { key: 'current', label: 'Current receivable', valueCentavos: current, count: Number(receivableRow.accounts), hint: 'Invoiced, not yet past the due date', tone: 'neutral' },
      { key: 'overdue', label: 'Overdue receivable', valueCentavos: arrears, count: Number(receivableRow.overdue_invoices), hint: 'Past the due date', tone: arrears > 0 ? 'danger' : 'good' },
      { key: 'overdueSubscribers', label: 'Subscribers overdue', valueCentavos: arrears, count: overdueSubscribers, hint: 'Subscribers holding a past-due balance', tone: overdueSubscribers > 0 ? 'warn' : 'good' },
      { key: 'followUp', label: 'Accounts to follow up', valueCentavos: arrears, count: followUp, hint: 'Service accounts past the due date', tone: followUp > 0 ? 'warn' : 'good' },
    ];
    return {
      asOf,
      generatedAt: new Date().toISOString(),
      monthLabel: `${MONTH_NAMES[Number(asOf.slice(5, 7)) - 1]} ${asOf.slice(0, 4)}`,
      monthStart,
      monthEnd: asOf,
      kpis,
      billingVsCollection: (trend.rows as Row[]).map((row) => ({
        period: String(row.period),
        label: bucketLabel(String(row.period), 'MONTH'),
        billedCentavos: money(Number(row.billed)),
        collectedCentavos: money(Number(row.collected)),
      })),
      paymentMethods: (methods.rows as Row[]).map((row) => ({ method: String(row.method), receipts: Number(row.receipts), collectedCentavos: money(Number(row.collected)) })),
      aging: buckets.map((entry) => ({
        bucket: entry.bucket, label: agingBucketLabels[entry.bucket], invoiceCount: entry.invoiceCount,
        accountCount: entry.accountCount, totalCentavos: money(entry.totalCentavos),
      })),
      receivableTotalCentavos: money(receivableTotal),
      collectors: (collectors.rows as Row[]).map((row) => ({
        collectorCode: String(row.code), collectorName: String(row.name), accounts: Number(row.accounts),
        expectedCashCentavos: 0, collectedCashCentavos: money(Number(row.collected)),
        remittedCentavos: money(Number(row.remitted)), varianceCentavos: money(Number(row.collected) - Number(row.remitted)),
      })),
      recentPayments: (recent.rows as Row[]).map((row) => ({
        id: row.id as Dashboard['recentPayments'][number]['id'],
        receiptNumber: row.receipt_number ? String(row.receipt_number) : null,
        method: String(row.method), status: String(row.status),
        receivedOn: String(row.received_on),
        amountCentavos: money(Number(row.amount_centavos)),
        subscriberCode: String(row.subscriber_code), subscriberName: String(row.subscriber_name),
        recordedName: String(row.recorded_name),
      })),
      overdueAlerts: (alerts.rows as Row[]).map((row) => {
        const oldest = String(row.oldest_due);
        const overdueDays = daysSince(oldest, asOf);
        return {
          serviceAccountId: row.id as Dashboard['overdueAlerts'][number]['serviceAccountId'],
          subscriberCode: String(row.code), subscriberName: String(row.name), planName: String(row.plan_name),
          areaName: String(row.area_name), collectorName: String(row.collector_name),
          arrearsCentavos: money(Number(row.arrears)), overdueDays, bucket: agingBucket(overdueDays),
        };
      }),
    };
  }

  /**
   * Exporting is a separate decision from reading, so it is authorised as `report.export`
   * and written to the audit trail in its own right. The report itself is then built under
   * `report.view`, which keeps the arithmetic on one code path: an export is never produced
   * by a second implementation of a report.
   */
  async forExport(token: string, code: ReportCode, raw: unknown, format: string) {
    const actor = await this.actor(token, 'report.export');
    const table = await this.build(token, code, raw);
    await this.auth.pool.query('INSERT INTO audit_logs(actor_id,action,subject_id,details) VALUES($1,$2,NULL,$3)',
      [actor.id, 'report.export', JSON.stringify({ report: code, format, from: table.from, to: table.to, rows: table.rowCount })]);
    return table;
  }
}

type AgingBucketKey = 'CURRENT' | 'D1_30' | 'D31_60' | 'D61_90' | 'D90_PLUS';

/** Days from `from` to `to`, with `to` as the day of reference. */
function daysSince(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
}