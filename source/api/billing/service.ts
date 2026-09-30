import type pg from 'pg';
import {
  AdjustmentInput, DraftInvoiceInput, DraftItemsInput, FinalizeInput, GenerateRunInput, InvoiceQuery, LedgerQuery, OverdueSweepInput, PageQuery, VoidInput,
  billingDates, cycleBounds, deriveStatus, formatInvoiceNumber, lineAmount, periodLabel, periodOf, sumLines, verifyRunningBalance,
  type LedgerEvent, type LineInput,
} from '../../shared/billing';
import { ApiError } from '../auth/errors';
import { parse } from '../master-data/service';
import type { AuthService } from '../auth/service';
import { lock, postLedgerEntry, type Client as LedgerClient } from './ledger';
import { spendCredit } from '../payments/allocation';

type Client = pg.Pool | pg.PoolClient | LedgerClient;
type Row = Record<string, unknown>;
type ItemRow = LineInput & { serviceAccountId?: string | null; planId?: string | null; planVersion?: number | null; planCode?: string; planName?: string };
type ServiceRow = { id: string; subscriber_id: string; plan_id: string; plan_version: number; plan_code: string; plan_name: string };
type InvoiceRow = {
  id: string; subscriber_id: string; service_account_id: string; status: string; invoice_number: string | null; issue_date: string; due_date: string;
  period_label: string; subtotal_centavos: number; adjustment_centavos: number; total_centavos: number; paid_centavos: number; balance_centavos: number; created_by: string;
};
const conflict = (message: string) => new ApiError(409, 'CONFLICT', message);
const invalid = (message: string, fields?: Record<string, string[]>) => new ApiError(422, 'VALIDATION', message, fields);

const invoiceSelect = `SELECT i.id,i.invoice_number AS "invoiceNumber",i.status,i.source,i.period_label AS "periodLabel",
  to_char(i.issue_date,'YYYY-MM-DD') AS "issueDate",to_char(i.due_date,'YYYY-MM-DD') AS "dueDate",
  i.subtotal_centavos AS "subtotalCentavos",i.adjustment_centavos AS "adjustmentCentavos",i.total_centavos AS "totalCentavos",
  i.paid_centavos AS "paidCentavos",i.balance_centavos AS "balanceCentavos",i.notes,i.void_reason AS "voidReason",
  i.created_at AS "createdAt",i.finalized_at AS "finalizedAt",i.voided_at AS "voidedAt",
  i.subscriber_id AS "subscriberId",s.code AS "subscriberCode",s.name AS "subscriberName",
  i.service_account_id AS "serviceAccountId",sa.code AS "serviceCode",sa.installation_address AS "serviceAddress",
  c.code AS "cycleCode",
  coalesce((SELECT jsonb_agg(jsonb_build_object('id',it.id,'lineNo',it.line_no,'itemType',it.item_type,'description',it.description,
      'serviceAccountId',it.service_account_id,'planId',it.plan_id,'planVersion',it.plan_version,'planCode',it.plan_code,'planName',it.plan_name,
      'quantity',it.quantity,'unitPriceCentavos',it.unit_price_centavos,'amountCentavos',it.amount_centavos) ORDER BY it.line_no)
    FROM invoice_items it WHERE it.invoice_id=i.id),'[]') AS items,
  coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'adjustmentType',a.adjustment_type,'amountCentavos',a.amount_centavos,
      'reason',a.reason,'actorName',u.display_name,'createdAt',a.created_at) ORDER BY a.created_at,a.id)
    FROM adjustments a JOIN users u ON u.id=a.actor_id WHERE a.invoice_id=i.id),'[]') AS adjustments
  FROM invoices i
  JOIN subscribers s ON s.id=i.subscriber_id
  JOIN service_accounts sa ON sa.id=i.service_account_id
  LEFT JOIN billing_cycles c ON c.id=i.cycle_id`;

const ledgerSelect = `SELECT l.id,l.entry_no AS "entryNo",to_char(l.entry_date,'YYYY-MM-DD') AS "entryDate",l.reference_type AS "referenceType",
  l.reference_number AS "referenceNumber",l.description,l.debit_centavos AS "debitCentavos",l.credit_centavos AS "creditCentavos",
  l.balance_centavos AS "balanceCentavos",l.invoice_id AS "invoiceId",i.invoice_number AS "invoiceNumber",l.reversal_of_id AS "reversalOfId",
  l.created_at AS "createdAt"
  FROM ledger_entries l LEFT JOIN invoices i ON i.id=l.invoice_id`;

export class BillingService {
  constructor(private auth: AuthService) {}

  private actor(token: string, permission: 'billing.view' | 'billing.generate', client?: Client) {
    return this.auth.authorize(token, permission, client);
  }

  /**
   * Starts a posting transaction. The transaction local `bcis.posting` flag is the
   * only way a session is allowed to change the figures of a finalised invoice, so a
   * direct SQL update outside this service is rejected by the database guard.
   */
  private async begin(client: Client) {
    await client.query('BEGIN');
    await client.query("SELECT set_config('bcis.posting','on',true)");
  }

  // ------------------------------------------------------------- cycle generation

  async generate(token: string, raw: unknown) {
    const input = parse(GenerateRunInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await this.begin(client);
      // Authorisation is re-checked inside the transaction so a revoked role cannot
      // race the permission check and still post documents.
      const actor = await this.actor(token, 'billing.generate', client);
      const { periodStart, periodEnd } = cycleBounds(input.period);
      await lock(client, `cycle:${input.period}`);
      const cycle = (await client.query(
        'INSERT INTO billing_cycles(code,period_start,period_end) VALUES($1,$2,$3) ON CONFLICT(code) DO UPDATE SET code=excluded.code RETURNING id',
        [input.period, periodStart, periodEnd],
      )).rows[0] as { id: string };
      // A period may be re-run at any time. The stored run is reused so the report is
      // stable, and only services without a finalised invoice for the period are added,
      // which is what makes a repeated generation safe (AT-11).
      const existing = (await client.query('SELECT id FROM billing_runs WHERE cycle_id=$1', [cycle.id])).rows[0] as { id: string } | undefined;
      const runId = existing?.id ?? (await client.query(
        'INSERT INTO billing_runs(cycle_id,as_of,actor_id,invoice_count,skipped_count,total_centavos) VALUES($1,$2,$3,0,0,0) RETURNING id',
        [cycle.id, input.asOf ?? periodEnd, actor.id],
      )).rows[0].id as string;
      const asOf = input.asOf ?? periodEnd;
      const billable = (await client.query(
        `SELECT sa.id,sa.subscriber_id,sa.plan_id,sa.plan_version,sa.current_rate_centavos,sa.billing_day,sa.due_day,p.code AS plan_code,p.name AS plan_name
         FROM service_accounts sa JOIN service_plans p ON p.id=sa.plan_id
         WHERE sa.status='ACTIVE' AND sa.billing_start_date<=$2
           AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.service_account_id=sa.id AND i.cycle_id=$1 AND i.status<>'VOID')
         ORDER BY sa.code`,
        [cycle.id, periodEnd],
      )).rows as Row[];
      const ineligible = (await client.query(
        `SELECT count(*)::int AS count FROM service_accounts sa
         WHERE sa.status='ACTIVE' AND sa.billing_start_date<=$2
           AND EXISTS (SELECT 1 FROM invoices i WHERE i.service_account_id=sa.id AND i.cycle_id=$1 AND i.status<>'VOID')`,
        [cycle.id, periodEnd],
      )).rows[0].count as number;
      for (const account of billable) {
        const dates = billingDates(periodStart, account.billing_day as number, account.due_day as number);
        const totalCentavos = account.current_rate_centavos as number;
        const invoiceId = await this.insertInvoice(client, {
          cycleId: cycle.id, runId, subscriberId: account.subscriber_id as string, serviceAccountId: account.id as string,
          status: 'DRAFT', source: 'CYCLE', periodLabel: periodLabel(input.period), ...dates, subtotalCentavos: totalCentavos,
          adjustmentCentavos: 0, totalCentavos, paidCentavos: 0, balanceCentavos: totalCentavos, notes: '', createdBy: actor.id,
        });
        await this.insertItem(client, invoiceId, 1, {
          itemType: 'SUBSCRIPTION', description: `Subscription ${periodLabel(input.period)}`, quantity: 1,
          unitPriceCentavos: totalCentavos, serviceAccountId: account.id as string, planId: account.plan_id as string,
          planVersion: account.plan_version as number, planCode: account.plan_code as string, planName: account.plan_name as string,
        });
        const invoiceNumber = await this.finalizeInvoice(client, invoiceId, asOf, actor.id);
        await postLedgerEntry(client, {
          subscriberId: account.subscriber_id as string, serviceAccountId: account.id as string, invoiceId,
          entryDate: dates.issueDate, referenceType: 'INVOICE', referenceId: invoiceId, referenceNumber: invoiceNumber,
          description: `Invoice ${invoiceNumber}`, debitCentavos: totalCentavos, creditCentavos: 0, actorId: actor.id,
        });
      }
      const totals = (await client.query(
        "SELECT count(*)::int AS invoice_count,coalesce(sum(total_centavos),0)::int AS total_centavos FROM invoices WHERE cycle_id=$1 AND status<>'VOID'",
        [cycle.id],
      )).rows[0] as { invoice_count: number; total_centavos: number };
      await client.query('UPDATE billing_runs SET as_of=$2,invoice_count=$3,skipped_count=$4,total_centavos=$5 WHERE id=$1', [runId, asOf, totals.invoice_count, ineligible, totals.total_centavos]);
      const run = (await client.query(
        'SELECT r.id,c.code AS "cycleCode",$2 AS "periodLabel",to_char(r.as_of,\'YYYY-MM-DD\') AS "asOf",r.invoice_count AS "invoiceCount",r.skipped_count AS "skippedCount",r.total_centavos AS "totalCentavos",u.display_name AS "actorName",r.created_at AS "createdAt" FROM billing_runs r JOIN billing_cycles c ON c.id=r.cycle_id JOIN users u ON u.id=r.actor_id WHERE r.id=$1',
        [runId, periodLabel(input.period)],
      )).rows[0];
      await this.audit(client, actor.id, `billing.run.${existing ? 'rerun' : 'generate'}`, runId, { cycle: input.period, issued: billable.length, skipped: ineligible });
      await client.query('COMMIT');
      return { ...run, idempotent: Boolean(existing) };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw conflict('That invoice already exists for this service account and period.');
      throw error;
    } finally { client.release(); }
  }

  // ------------------------------------------------------------- invoice documents

  async listRuns(token: string, raw: unknown) {
    await this.actor(token, 'billing.view');
    const query = parse(PageQuery, raw);
    const result = await this.auth.pool.query(
      `SELECT r.id,c.code AS "cycleCode",to_char(c.period_start,'YYYY-MM-DD') AS "periodStart",to_char(c.period_end,'YYYY-MM-DD') AS "periodEnd",to_char(r.as_of,'YYYY-MM-DD') AS "asOf",
        r.invoice_count AS "invoiceCount",r.skipped_count AS "skippedCount",r.total_centavos AS "totalCentavos",u.display_name AS "actorName",r.created_at AS "createdAt"
       FROM billing_runs r JOIN billing_cycles c ON c.id=r.cycle_id JOIN users u ON u.id=r.actor_id
       ORDER BY c.code DESC LIMIT $1 OFFSET $2`, [query.perPage, (query.page - 1) * query.perPage]);
    const count = await this.auth.pool.query('SELECT count(*)::int AS total FROM billing_runs');
    const items = (result.rows as { cycleCode: string }[]).map(row => ({ ...row, periodLabel: periodLabel(row.cycleCode) }));
    return { items, total: count.rows[0].total, page: query.page, perPage: query.perPage };
  }

  async listCycles(token: string) {
    await this.actor(token, 'billing.view');
    const result = await this.auth.pool.query(
      `SELECT c.id,c.code,to_char(c.period_start,'YYYY-MM-DD') AS "periodStart",to_char(c.period_end,'YYYY-MM-DD') AS "periodEnd",
        (r.id IS NOT NULL) AS generated,coalesce(counts.invoice_count,0)::int AS "invoiceCount"
       FROM billing_cycles c LEFT JOIN billing_runs r ON r.cycle_id=c.id
       LEFT JOIN (SELECT cycle_id,count(*)::int AS invoice_count FROM invoices WHERE status<>'VOID' GROUP BY cycle_id) counts ON counts.cycle_id=c.id
       ORDER BY c.code DESC`);
    return { items: result.rows, total: result.rowCount };
  }

  async listInvoices(token: string, raw: unknown) {
    await this.actor(token, 'billing.view');
    const query = parse(InvoiceQuery, raw);
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (query.q) {
      values.push(`%${query.q.replace(/[\\%_]/g, '\\$&')}%`);
      conditions.push(`(i.invoice_number ILIKE $${values.length} OR s.code::text ILIKE $${values.length} OR s.name::text ILIKE $${values.length} OR sa.code::text ILIKE $${values.length} OR sa.installation_address::text ILIKE $${values.length})`);
    }
    if (query.status) { values.push(query.status); conditions.push(`i.status=$${values.length}`); }
    if (query.subscriberId) { values.push(query.subscriberId); conditions.push(`i.subscriber_id=$${values.length}`); }
    if (query.cycleCode) { values.push(query.cycleCode); conditions.push(`c.code=$${values.length}`); }
    if (query.serviceAccountId) { values.push(query.serviceAccountId); conditions.push(`i.service_account_id=$${values.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    // One statement gives the count and the page a consistent snapshot, even when the
    // requested page is empty.
    const result = await this.auth.pool.query(
      `WITH filtered AS (SELECT i.id FROM invoices i JOIN subscribers s ON s.id=i.subscriber_id JOIN service_accounts sa ON sa.id=i.service_account_id LEFT JOIN billing_cycles c ON c.id=i.cycle_id ${where}),
       page AS (SELECT id FROM filtered ORDER BY (SELECT issue_date FROM invoices WHERE id=filtered.id) DESC,id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2})
       SELECT coalesce((SELECT jsonb_agg(to_jsonb(document)) FROM (${invoiceSelect} WHERE i.id IN (SELECT id FROM page) ORDER BY i.issue_date DESC,i.id DESC) document),'[]') AS items,
         (SELECT count(*)::int FROM filtered) AS total`,
      values.concat([query.perPage, (query.page - 1) * query.perPage]));
    return { items: result.rows[0].items, total: result.rows[0].total, page: query.page, perPage: query.perPage };
  }

  async getInvoice(token: string, id: string) {
    await this.actor(token, 'billing.view');
    const result = await this.auth.pool.query(`${invoiceSelect} WHERE i.id=$1`, [id]);
    if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Invoice not found.');
    return result.rows[0];
  }

  // ------------------------------------------------------------- manual invoices

  async createDraft(token: string, raw: unknown) {
    const input = parse(DraftInvoiceInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await this.begin(client);
      const actor = await this.actor(token, 'billing.generate', client);
      const account = await this.activeService(client, input.serviceAccountId);
      const totals = this.totals(input.items);
      const invoiceId = await this.insertInvoice(client, {
        cycleId: null, runId: null, subscriberId: account.subscriber_id, serviceAccountId: account.id, status: 'DRAFT', source: 'MANUAL',
        periodLabel: periodLabel(periodOf(input.issueDate)), issueDate: input.issueDate, dueDate: input.dueDate,
        ...totals, balanceCentavos: totals.totalCentavos, paidCentavos: 0, notes: input.notes, createdBy: actor.id,
      });
      for (const [index, line] of input.items.entries()) {
        await this.insertItem(client, invoiceId, index + 1, { ...line, serviceAccountId: account.id, planId: account.plan_id, planVersion: account.plan_version, planCode: account.plan_code, planName: account.plan_name });
      }
      await this.audit(client, actor.id, 'billing.invoice.draft', invoiceId, { issueDate: input.issueDate, items: input.items.length });
      await client.query('COMMIT');
      return await this.read(client, invoiceId);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async replaceDraftItems(token: string, id: string, raw: unknown) {
    const input = parse(DraftItemsInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await this.begin(client);
      const actor = await this.actor(token, 'billing.generate', client);
      const invoice = await this.postedInvoice(client, id);
      if (invoice.status !== 'DRAFT') throw conflict('A finalised invoice can no longer be re-issued. Add an adjustment or void it instead.');
      const account = await this.activeService(client, invoice.service_account_id as string);
      const totals = this.totals(input.items);
      // Replacing the lines of a draft is the one permitted edit, and the database
      // trigger allows it only while the parent invoice is still a DRAFT.
      await client.query('DELETE FROM invoice_items WHERE invoice_id=$1', [id]);
      for (const [index, line] of input.items.entries()) {
        await this.insertItem(client, id, index + 1, { ...line, serviceAccountId: account.id, planId: account.plan_id, planVersion: account.plan_version, planCode: account.plan_code, planName: account.plan_name });
      }
      await client.query('UPDATE invoices SET subtotal_centavos=$2,adjustment_centavos=$3,total_centavos=$4,balance_centavos=$4 WHERE id=$1', [id, totals.subtotalCentavos, totals.adjustmentCentavos, totals.totalCentavos]);
      await this.audit(client, actor.id, 'billing.invoice.reissue', id, { reason: input.reason, ...totals });
      await client.query('COMMIT');
      return await this.read(client, id);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async finalize(token: string, id: string, raw: unknown) {
    const input = parse(FinalizeInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await this.begin(client);
      const actor = await this.actor(token, 'billing.generate', client);
      const invoice = await this.postedInvoice(client, id);
      if (invoice.status !== 'DRAFT') throw conflict('This invoice is already finalised.');
      const invoiceNumber = await this.finalizeInvoice(client, id, input.asOf, actor.id);
      if (invoice.total_centavos > 0) {
        await postLedgerEntry(client, {
          subscriberId: invoice.subscriber_id, serviceAccountId: invoice.service_account_id, invoiceId: id,
          entryDate: invoice.issue_date, referenceType: 'INVOICE', referenceId: id, referenceNumber: invoiceNumber,
          description: `Invoice ${invoiceNumber}`, debitCentavos: invoice.total_centavos, creditCentavos: 0, actorId: actor.id,
        });
      }
      await this.audit(client, actor.id, 'billing.invoice.finalize', id, { reason: input.reason, totalCentavos: invoice.total_centavos });
      await client.query('COMMIT');
      return await this.read(client, id);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  // ------------------------------------------------------------- corrections

  async adjust(token: string, id: string, raw: unknown) {
    const input = parse(AdjustmentInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await this.begin(client);
      const actor = await this.actor(token, 'billing.generate', client);
      const invoice = await this.postedInvoice(client, id);
      if (invoice.status === 'DRAFT') throw conflict('Reissue the draft instead of adjusting it, so the lines are replaced before a number is assigned.');
      if (invoice.status === 'VOID') throw conflict('A voided invoice cannot be adjusted.');
      const signed = input.adjustmentType === 'CREDIT' ? -input.amountCentavos : input.amountCentavos;
      const balance = invoice.balance_centavos;
      // A credit never settles the invoice; settlement by credit is a Phase 5 workflow.
      if (signed < 0 && -signed >= balance) throw invalid('The credit must be less than the outstanding balance of this invoice.', { amountCentavos: ['Reduce the credit amount.'] });
      const nextTotal = invoice.total_centavos + signed;
      if (nextTotal < 0) throw invalid('The adjustment would make the invoice total negative.', { amountCentavos: ['Reduce the adjustment amount.'] });
      const line = (await client.query('SELECT coalesce(max(line_no),0)::int AS line FROM invoice_items WHERE invoice_id=$1', [id])).rows[0].line as number;
      await client.query('INSERT INTO adjustments(invoice_id,adjustment_type,amount_centavos,reason,actor_id) VALUES($1,$2,$3,$4,$5)', [id, input.adjustmentType, input.amountCentavos, input.reason, actor.id]);
      await this.insertItem(client, id, line + 1, {
        itemType: 'ADJUSTMENT', description: input.reason, quantity: 1, unitPriceCentavos: input.amountCentavos, amountCentavos: signed,
        serviceAccountId: invoice.service_account_id, planId: null, planVersion: null, planCode: '', planName: '',
      });
      await client.query('UPDATE invoices SET adjustment_centavos=adjustment_centavos+$2,total_centavos=total_centavos+$2,balance_centavos=balance_centavos+$2 WHERE id=$1', [id, signed]);
      await postLedgerEntry(client, {
        subscriberId: invoice.subscriber_id, serviceAccountId: invoice.service_account_id, invoiceId: id,
        entryDate: new Date().toISOString().slice(0, 10), referenceType: 'ADJUSTMENT', referenceId: id, referenceNumber: invoice.invoice_number ?? '',
        description: `${input.adjustmentType === 'CREDIT' ? 'Credit' : 'Debit'} adjustment: ${input.reason}`,
        debitCentavos: signed > 0 ? signed : 0, creditCentavos: signed < 0 ? -signed : 0, actorId: actor.id,
      });
      await this.audit(client, actor.id, 'billing.invoice.adjust', id, { ...input, signedCentavos: signed });
      await client.query('COMMIT');
      return await this.read(client, id);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async voidInvoice(token: string, id: string, raw: unknown) {
    const input = parse(VoidInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await this.begin(client);
      const actor = await this.actor(token, 'billing.generate', client);
      const invoice = await this.postedInvoice(client, id);
      if (invoice.status === 'VOID') throw conflict('This invoice is already voided.');
      // The original document, its lines and its number are kept; only the balance and
      // the status change, and a linked reversal restores the ledger.
      const posted = (await client.query('SELECT coalesce(sum(debit_centavos-credit_centavos),0)::int AS posted FROM ledger_entries WHERE invoice_id=$1', [id])).rows[0] as { posted: number };
      if (posted.posted > 0) {
        const original = (await client.query('SELECT id FROM ledger_entries WHERE invoice_id=$1 AND debit_centavos>0 ORDER BY entry_no LIMIT 1', [id])).rows[0] as { id: string };
        await postLedgerEntry(client, {
          subscriberId: invoice.subscriber_id, serviceAccountId: invoice.service_account_id, invoiceId: id,
          entryDate: new Date().toISOString().slice(0, 10), referenceType: 'VOID', referenceId: id, referenceNumber: invoice.invoice_number ?? '',
          description: `Void ${invoice.invoice_number ?? 'invoice'}: ${input.reason}`, debitCentavos: 0, creditCentavos: posted.posted,
          reversalOfId: original.id, actorId: actor.id,
        });
      }
      await client.query("UPDATE invoices SET status='VOID',voided_at=now(),void_reason=$2,paid_centavos=total_centavos,balance_centavos=0 WHERE id=$1", [id, input.reason]);
      await this.audit(client, actor.id, 'billing.invoice.void', id, { reason: input.reason, reversedCentavos: posted.posted });
      await client.query('COMMIT');
      return await this.read(client, id);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async overdueSweep(token: string, raw: unknown) {
    const input = parse(OverdueSweepInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await this.begin(client);
      const actor = await this.actor(token, 'billing.generate', client);
      const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
      const marked = (await client.query(
        "UPDATE invoices SET status='OVERDUE' WHERE status IN ('UNPAID','PARTIALLY_PAID') AND balance_centavos>0 AND due_date<$1 RETURNING id,balance_centavos",
        [asOf],
      )).rows as { id: string; balance_centavos: number }[];
      await this.audit(client, actor.id, 'billing.invoice.overdue', null, { asOf, marked: marked.length });
      await client.query('COMMIT');
      return { asOf, markedCount: marked.length, markedCentavos: marked.reduce((sum, row) => sum + row.balance_centavos, 0) };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  // ------------------------------------------------------------- subscriber ledger

  async ledger(token: string, raw: unknown) {
    await this.actor(token, 'billing.view');
    const query = parse(LedgerQuery, raw);
    if (!query.subscriberId) throw invalid('Choose a subscriber to open the account ledger.', { subscriberId: ['This field is required.'] });
    const subscriber = (await this.auth.pool.query('SELECT id,code,name FROM subscribers WHERE id=$1', [query.subscriberId])).rows[0] as { id: string; code: string; name: string } | undefined;
    if (!subscriber) throw new ApiError(404, 'NOT_FOUND', 'Subscriber not found.');
    // The complete statement is read, never a page of it, so the running balance can be
    // reproduced from the append-only entries and a date range can open with the balance
    // brought forward from the entries before it.
    const history = (await this.auth.pool.query(`${ledgerSelect} WHERE l.subscriber_id=$1 ORDER BY l.entry_date,l.entry_no`, [query.subscriberId])).rows as unknown as LedgerEvent[];
    const { differences } = verifyRunningBalance(history);
    if (differences.length) {
      throw new ApiError(500, 'LEDGER_INCONSISTENT', 'The subscriber ledger failed verification. Report this to an administrator.');
    }
    const net = (entries: LedgerEvent[]) => entries.reduce((sum, entry) => sum + entry.debitCentavos - entry.creditCentavos, 0);
    const { from, to } = query;
    // The date range is inclusive on both ends and compares ISO dates as text.
    const inRange = history.filter(entry => (!from || entry.entryDate >= from) && (!to || entry.entryDate <= to));
    const page = inRange.slice((query.page - 1) * query.perPage, query.page * query.perPage);
    // A range opens with the entries that precede it, while a full statement is paged
    // and opens with the balance of the lines before the page.
    const rangeOpening = from ? net(history.filter(entry => entry.entryDate < from)) : 0;
    const opening = from ? rangeOpening : net(inRange.slice(0, (query.page - 1) * query.perPage));
    return {
      subscriberId: subscriber.id, subscriberCode: subscriber.code, subscriberName: subscriber.name,
      openingBalanceCentavos: opening,
      // The closing balance is the account balance reached at the end of the range, so it
      // does not change when only the page changes.
      closingBalanceCentavos: rangeOpening + net(inRange),
      totalDebitCentavos: inRange.reduce((sum, entry) => sum + entry.debitCentavos, 0),
      totalCreditCentavos: inRange.reduce((sum, entry) => sum + entry.creditCentavos, 0),
      verified: true, items: page, total: inRange.length, page: query.page, perPage: query.perPage,
    };
  }

  // ------------------------------------------------------------- shared helpers

  private totals(items: LineInput[]) {
    try { return sumLines(items); }
    catch (error) { throw invalid(error instanceof RangeError ? error.message : 'Check the line amounts.', { items: ['Check the line amounts.'] }); }
  }

  private async activeService(client: Client, serviceAccountId: string) {
    const row = (await client.query(
      `SELECT sa.id,sa.subscriber_id,sa.plan_id,sa.plan_version,p.code AS plan_code,p.name AS plan_name
       FROM service_accounts sa JOIN service_plans p ON p.id=sa.plan_id
       JOIN subscribers s ON s.id=sa.subscriber_id
       WHERE sa.id=$1 AND sa.status='ACTIVE' AND s.status='ACTIVE'`,
      [serviceAccountId],
    )).rows[0] as ServiceRow | undefined;
    if (!row) throw invalid('Select an existing active service account.', { serviceAccountId: ['This service account is missing or inactive.'] });
    return row;
  }

  private async postedInvoice(client: Client, id: string) {
    const row = (await client.query(
      `SELECT id,subscriber_id,service_account_id,status,invoice_number,
        to_char(issue_date,'YYYY-MM-DD') AS issue_date,to_char(due_date,'YYYY-MM-DD') AS due_date,period_label,
        subtotal_centavos,adjustment_centavos,total_centavos,paid_centavos,balance_centavos,created_by
       FROM invoices WHERE id=$1 FOR UPDATE`,
      [id],
    )).rows[0] as InvoiceRow | undefined;
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Invoice not found.');
    return row;
  }

  private async insertInvoice(client: Client, invoice: Row) {
    const result = await client.query(
      `INSERT INTO invoices(cycle_id,run_id,subscriber_id,service_account_id,status,source,period_label,issue_date,due_date,
        subtotal_centavos,adjustment_centavos,total_centavos,paid_centavos,balance_centavos,notes,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [invoice.cycleId, invoice.runId, invoice.subscriberId, invoice.serviceAccountId, invoice.status, invoice.source, invoice.periodLabel,
        invoice.issueDate, invoice.dueDate, invoice.subtotalCentavos, invoice.adjustmentCentavos, invoice.totalCentavos,
        invoice.paidCentavos ?? 0, invoice.balanceCentavos ?? 0, invoice.notes ?? '', invoice.createdBy],
    );
    return result.rows[0].id as string;
  }

  private async insertItem(client: Client, invoiceId: string, lineNo: number, line: ItemRow) {
    await client.query(
      `INSERT INTO invoice_items(invoice_id,line_no,item_type,description,service_account_id,plan_id,plan_version,plan_code,plan_name,quantity,unit_price_centavos,amount_centavos)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [invoiceId, lineNo, line.itemType, line.description, line.serviceAccountId ?? null, line.planId ?? null, line.planVersion ?? null,
        line.planCode ?? '', line.planName ?? '', line.quantity ?? 1, line.unitPriceCentavos, lineAmount(line)],
    );
  }

  /** Allocates a gap-free, never-reused number and leaves the invoice finalised. */
  private async finalizeInvoice(client: Client, id: string, asOf?: string, actorId?: string) {
    const row = (await client.query(
      "SELECT to_char(issue_date,'YYYY-MM-DD') AS issue_date,to_char(due_date,'YYYY-MM-DD') AS due_date,total_centavos FROM invoices WHERE id=$1",
      [id],
    )).rows[0] as { issue_date: string; due_date: string; total_centavos: number };
    const year = Number(row.issue_date.slice(0, 4));
    await lock(client, `document:invoice:${year}`);
    const sequence = (await client.query(
      `INSERT INTO document_sequences(kind,year,next_value) VALUES('INVOICE',$1,1002) ON CONFLICT(kind,year) DO UPDATE SET next_value=document_sequences.next_value+1 RETURNING next_value-1 AS value`,
      [year],
    )).rows[0].value as number;
    const status = deriveStatus({
      totalCentavos: row.total_centavos, paidCentavos: 0, dueDate: row.due_date,
      asOf: asOf ?? new Date().toISOString().slice(0, 10), voided: false,
    });
    await client.query('UPDATE invoices SET invoice_number=$2,status=$3,finalized_at=now() WHERE id=$1', [id, formatInvoiceNumber(year, sequence), status]);
    if (actorId) await this.audit(client, actorId, 'billing.invoice.number', id, { year, sequence });
    // A credit already held by the subscriber settles this invoice straight away, so the
    // stored figures and the status always describe the same document.
    const subscriberId = (await client.query('SELECT subscriber_id FROM invoices WHERE id=$1', [id])).rows[0].subscriber_id as string;
    const settledCentavos = await this.applyHeldCredit(client, subscriberId, asOf, actorId);
    if (actorId && settledCentavos) await this.audit(client, actorId, 'billing.invoice.advance', id, { settledCentavos });
    return formatInvoiceNumber(year, sequence);
  }

  /**
   * Applies any credit the subscriber already holds to the invoice that was just
   * finalised, oldest due date first. A held credit is spent before the next payment
   * arrives, so an invoice can leave the DRAFT state already settled by credit.
   */
  private async applyHeldCredit(client: Client, subscriberId: string, asOf?: string, actorId?: string) {
    if (!actorId) return 0;
    return spendCredit(client, subscriberId, asOf ?? new Date().toISOString().slice(0, 10), actorId);
  }

  private async read(client: Client, id: string) {
    const result = await client.query(`${invoiceSelect} WHERE i.id=$1`, [id]);
    if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Invoice not found.');
    return result.rows[0];
  }

  private audit(client: Client, actorId: string, action: string, subjectId: string | null, details: unknown) {
    return client.query('INSERT INTO audit_logs(actor_id,action,subject_id,details) VALUES($1,$2,$3,$4)', [actorId, action, subjectId, JSON.stringify(details)]);
  }
}
