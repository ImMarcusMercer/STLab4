import {
  AssignTechnicianInput, CompleteReconnectionInput, LiftSuspensionInput, ReceivableQuery, RequestReconnectionInput,
  ServicePolicySchema, SuspendServiceInput, SuspensionQuery, UpdatePolicyInput, agingBucket, agingBucketValues,
  formatReconnectionNumber, formatSuspensionNumber, monthsUnpaid, overdueDays, qualifiesForSuspension,
  reconnectionBlockedBy,
  type AgingBucket, type ReceivableList, type ReceivableRow, type ReceivableSummary, type ServiceControlEvent, type ServicePolicy,
  type Suspension, type SuspensionList,
} from '../../shared/receivables';
import { ApiError } from '../auth/errors';
import type { AuthService } from '../auth/service';
import { parse } from '../master-data/service';
import { lock, type Client } from '../billing/ledger';

type Permission = 'receivable.view' | 'service.control';
type Row = Record<string, unknown>;
const conflict = (message: string) => new ApiError(409, 'CONFLICT', message);
const invalid = (message: string, fields?: Record<string, string[]>) => new ApiError(422, 'VALIDATION', message, fields);
const today = () => new Date().toISOString().slice(0, 10);
const pesos = (centavos: number) => `PHP ${(centavos / 100).toFixed(2)}`;
/**
 * A sum over a whole office, in centavos, as a number.
 *
 * The totals are cast to bigint rather than int, because a receivable of more than
 * PHP 21,474,836.47 overflows a 32-bit integer, and a subscriber base of twenty thousand
 * accounts passes that without any single figure looking unusual. PostgreSQL hands a bigint
 * back as a string, so it is converted here; the published contract carries a number.
 */
const money = (value: unknown) => Number(value);

/** Marks the transaction as one that may move a service account in or out of SUSPENDED. */
export const markServiceControlTransaction = (client: Client) => client.query("SELECT set_config('bcis.control','on',true)");

/**
 * Phase 7: receivables monitoring and service control.
 *
 * A receivable is never stored. Every peso is read from the open invoices on the day it is
 * asked for, so the aging report cannot drift away from the ledger it claims to summarise,
 * and a payment reduces the receivable without anything being recalculated by hand.
 *
 * What IS stored are the decisions: a suspension and a reconnection, each a document with a
 * number, a reason, an actor and the figures that were true when it was raised.
 */
export class ReceivablesService {
  constructor(private auth: AuthService) {}

  private actor(token: string, permission: Permission, client?: Client) {
    return this.auth.authorize(token, permission, client);
  }

  private audit(client: Client, actorId: string, action: string, subjectId: string | null, details: unknown) {
    return client.query('INSERT INTO audit_logs(actor_id,action,subject_id,details) VALUES($1,$2,$3,$4)', [actorId, action, subjectId, JSON.stringify(details)]);
  }

  /** Gap-free per-year numbering, the same mechanism the invoice and receipt numbers use. */
  private async nextNumber(client: Client, kind: 'SUSPENSION' | 'RECONNECTION', year: number, format: (year: number, value: number) => string) {
    await lock(client, `document:${kind.toLowerCase()}:${year}`);
    const value = (await client.query(
      `INSERT INTO document_sequences(kind,year,next_value) VALUES($1,$2,1002) ON CONFLICT(kind,year) DO UPDATE SET next_value=document_sequences.next_value+1 RETURNING next_value-1 AS value`,
      [kind, year],
    )).rows[0].value as number;
    return format(year, value);
  }

  // -------------------------------------------------------------- policy

  private async policy(client: Client): Promise<ServicePolicy> {
    const row = (await client.query(
      `SELECT p.id,p.grace_period_days AS "gracePeriodDays",p.suspension_threshold_centavos AS "suspensionThresholdCentavos",
        p.auto_suspend AS "autoSuspend",p.reconnection_fee_centavos AS "reconnectionFeeCentavos",
        p.updated_by AS "updatedBy",u.display_name AS "updatedName",p.updated_at AS "updatedAt"
       FROM service_policy p JOIN users u ON u.id=p.updated_by ORDER BY p.updated_at DESC LIMIT 1`,
    )).rows[0] as Row | undefined;
    // An office that has never saved a policy gets no surprises: nothing is over the
    // threshold and the grace period is a year, so no account is suspended by accident.
    return row
      ? ServicePolicySchema.parse({ ...row, updatedAt: new Date(row.updatedAt as string).toISOString() })
      : { id: '', gracePeriodDays: 365, suspensionThresholdCentavos: 0, autoSuspend: false, reconnectionFeeCentavos: 0, updatedBy: '', updatedName: 'Not configured', updatedAt: new Date(0).toISOString() };
  }

  async getPolicy(token: string) {
    const client = await this.auth.pool.connect();
    try { await this.actor(token, 'service.control', client); return await this.policy(client); }
    finally { client.release(); }
  }

  /**
   * The policy is appended rather than edited: every decision to change the rule keeps the
   * person who made it and the reason. A suspension already taken keeps its own copy of the
   * policy it was made under, so changing the rule now cannot rewrite a past decision.
   */
  async updatePolicy(token: string, raw: unknown) {
    const input = parse(UpdatePolicyInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await client.query('BEGIN');
      const actor = await this.actor(token, 'service.control', client);
      await client.query(
        `INSERT INTO service_policy(grace_period_days,suspension_threshold_centavos,auto_suspend,reconnection_fee_centavos,updated_by) VALUES($1,$2,$3,$4,$5)`,
        [input.gracePeriodDays, input.suspensionThresholdCentavos, input.autoSuspend, input.reconnectionFeeCentavos, actor.id],
      );
      await this.audit(client, actor.id, 'service.policy.update', null, { ...input });
      await client.query('COMMIT');
      return await this.policy(client);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  // -------------------------------------------------------------- receivables

  /** An invoice is open while it still owes something; a void or draft invoice owes nothing. */
  private openInvoices = `i.status IN ('UNPAID','PARTIALLY_PAID','OVERDUE') AND i.balance_centavos>0`;

  /**
   * One row per service account, with its current balance, its arrears, the oldest unpaid
   * invoice and the periods still unpaid. Nothing is grouped in application code, so the
   * list and the summary are guaranteed to be counting the same peso.
   */
  private receivableSelect = `
    SELECT sa.id AS "serviceAccountId",s.id AS "subscriberId",s.code AS "subscriberCode",s.name AS "subscriberName",
      sa.code AS "serviceCode",p.code AS "planCode",p.name AS "planName",p.service_type AS "serviceType",
      coalesce(sa.installation_address,'') AS "address",sa.area_id AS "areaId",coalesce(ca.name,'') AS "areaName",
      sa.collector_id AS "collectorId",coalesce(cl.name,'') AS "collectorName",sa.status AS "serviceStatus",
      agg."currentCentavos",agg."arrearsCentavos",agg."oldestUnpaidDueDate",
      coalesce(agg."oldestUnpaidInvoiceNumber",'') AS "oldestUnpaidInvoiceNumber",
      coalesce(agg."oldestUnpaidPeriodLabel",'') AS "oldestUnpaidPeriodLabel",
      coalesce(agg."unpaidPeriods",ARRAY[]::text[]) AS "unpaidPeriods",
      coalesce((SELECT to_char(pay.received_on,'YYYY-MM-DD') FROM payments pay
        WHERE pay.subscriber_id=s.id AND pay.status='POSTED' AND pay.direction='PAYMENT'
        ORDER BY pay.received_on DESC,pay.created_at DESC LIMIT 1),NULL) AS "lastPaymentDate",
      coalesce((SELECT pay.amount_centavos FROM payments pay
        WHERE pay.subscriber_id=s.id AND pay.status='POSTED' AND pay.direction='PAYMENT'
        ORDER BY pay.received_on DESC,pay.created_at DESC LIMIT 1),0)::int AS "lastPaymentAmountCentavos"
    FROM service_accounts sa
    JOIN subscribers s ON s.id=sa.subscriber_id
    JOIN service_plans p ON p.id=sa.plan_id
    LEFT JOIN collection_areas ca ON ca.id=sa.area_id
    LEFT JOIN collectors cl ON cl.id=sa.collector_id
    JOIN LATERAL (
      SELECT coalesce(sum(i.balance_centavos) FILTER (WHERE i.due_date>=$1),0)::int AS "currentCentavos",
        coalesce(sum(i.balance_centavos) FILTER (WHERE i.due_date<$1),0)::int AS "arrearsCentavos",
        to_char(min(i.due_date) FILTER (WHERE i.due_date<$1),'YYYY-MM-DD') AS "oldestUnpaidDueDate",
        (array_agg(i.invoice_number ORDER BY i.due_date,i.issue_date,i.id) FILTER (WHERE i.due_date<$1))[1] AS "oldestUnpaidInvoiceNumber",
        (array_agg(i.period_label ORDER BY i.due_date,i.issue_date,i.id) FILTER (WHERE i.due_date<$1))[1] AS "oldestUnpaidPeriodLabel",
        array_agg(DISTINCT i.period_label) FILTER (WHERE i.due_date<$1) AS "unpaidPeriods"
      FROM invoices i WHERE i.service_account_id=sa.id AND ${this.openInvoices}
    ) agg ON true`;

  private project(row: Row, asOf: string, policy: ServicePolicy): ReceivableRow {
    const arrears = row.arrearsCentavos as number;
    const current = row.currentCentavos as number;
    const oldestDueDate = (row.oldestUnpaidDueDate as string | null) ?? null;
    // An account with nothing overdue has nothing to age. It is reported in the current
    // bucket on the as-of day, so the report never invents a due date for it.
    const days = oldestDueDate ? overdueDays(oldestDueDate, asOf) : 0;
    const candidate = oldestDueDate
      ? qualifiesForSuspension({ arrearsCentavos: arrears, oldestUnpaidDueDate: oldestDueDate, asOf, thresholdCentavos: policy.suspensionThresholdCentavos, gracePeriodDays: policy.gracePeriodDays })
      : { eligible: false, overdueDays: days, reason: 'BELOW_THRESHOLD' as const };
    return {
      serviceAccountId: row.serviceAccountId as string,
      subscriberId: row.subscriberId as string,
      subscriberCode: row.subscriberCode as string,
      subscriberName: row.subscriberName as string,
      serviceCode: row.serviceCode as string,
      planCode: row.planCode as string,
      planName: row.planName as string,
      serviceType: row.serviceType as string,
      address: row.address as string,
      areaId: row.areaId as string | null,
      areaName: row.areaName as string,
      collectorId: row.collectorId as string | null,
      collectorName: row.collectorName as string,
      currentCentavos: current,
      arrearsCentavos: arrears,
      totalArrearsCentavos: arrears,
      monthsUnpaid: monthsUnpaid((row.unpaidPeriods as string[]) ?? []),
      oldestUnpaidDueDate: oldestDueDate ?? asOf,
      oldestUnpaidInvoiceNumber: (row.oldestUnpaidInvoiceNumber as string) || '—',
      oldestUnpaidPeriodLabel: (row.oldestUnpaidPeriodLabel as string) || '—',
      bucket: arrears > 0 ? agingBucket(days) : 'CURRENT',
      overdueDays: days,
      lastPaymentDate: (row.lastPaymentDate as string) ?? null,
      lastPaymentAmountCentavos: row.lastPaymentAmountCentavos as number,
      serviceStatus: row.serviceStatus as string,
      suspensionCandidate: candidate.eligible,
    };
  }

  /**
   * The dashboard figures. Every amount is a sum over the same open invoices the list uses,
   * and the aging buckets are computed from the same boundaries as the published
   * `agingBucket` helper, so the buckets always add back to the total receivable.
   */
  async summary(token: string, raw: unknown): Promise<ReceivableSummary> {
    await this.actor(token, 'receivable.view');
    const input = parse(ReceivableQuery.pick({ asOf: true }), raw);
    const asOf = input.asOf ?? today();
    const client = await this.auth.pool.connect();
    try {
      const policy = await this.policy(client);
      const totals = (await client.query(
        `SELECT coalesce(sum(i.balance_centavos) FILTER (WHERE i.due_date>=$1),0)::bigint AS "currentCentavos",
          coalesce(sum(i.balance_centavos) FILTER (WHERE i.due_date<$1),0)::bigint AS "arrearsCentavos"
         FROM invoices i WHERE ${this.openInvoices}`, [asOf],
      )).rows[0] as Row;
      const aging = (await client.query(
        `SELECT count(*) FILTER (WHERE i.due_date>=$1)::int AS "currentCount",
          coalesce(sum(i.balance_centavos) FILTER (WHERE i.due_date>=$1),0)::bigint AS "currentCentavos",
          count(*) FILTER (WHERE i.due_date<$1 AND i.due_date>=$1::date-30)::int AS "d1Count",
          coalesce(sum(i.balance_centavos) FILTER (WHERE i.due_date<$1 AND i.due_date>=$1::date-30),0)::bigint AS "d1Centavos",
          count(*) FILTER (WHERE i.due_date<$1::date-30 AND i.due_date>=$1::date-60)::int AS "d2Count",
          coalesce(sum(i.balance_centavos) FILTER (WHERE i.due_date<$1::date-30 AND i.due_date>=$1::date-60),0)::bigint AS "d2Centavos",
          count(*) FILTER (WHERE i.due_date<$1::date-60 AND i.due_date>=$1::date-90)::int AS "d3Count",
          coalesce(sum(i.balance_centavos) FILTER (WHERE i.due_date<$1::date-60 AND i.due_date>=$1::date-90),0)::bigint AS "d3Centavos",
          count(*) FILTER (WHERE i.due_date<$1::date-90)::int AS "d4Count",
          coalesce(sum(i.balance_centavos) FILTER (WHERE i.due_date<$1::date-90),0)::bigint AS "d4Centavos"
         FROM invoices i WHERE ${this.openInvoices}`, [asOf],
      )).rows[0] as Row;
      const accounts = (await client.query(
        `SELECT count(*)::int AS "accountCount",
          count(*) FILTER (WHERE agg.arrears>0)::int AS "followUpCount",
          count(DISTINCT agg.subscriber_id) FILTER (WHERE agg.arrears>0)::int AS "overdueSubscriberCount",
          count(*) FILTER (WHERE agg.arrears>0 AND agg.oldest_due_date IS NOT NULL
            AND ($1::date-agg.oldest_due_date)>=$2 AND agg.arrears>=$3)::int AS "suspensionCandidateCount"
         FROM (
           SELECT sa.id,sa.subscriber_id,
             coalesce(sum(i.balance_centavos) FILTER (WHERE i.due_date<$1),0)::int AS arrears,
             min(i.due_date) FILTER (WHERE i.due_date<$1) AS oldest_due_date
           FROM service_accounts sa JOIN invoices i ON i.service_account_id=sa.id AND ${this.openInvoices}
           GROUP BY sa.id,sa.subscriber_id
         ) agg`, [asOf, policy.gracePeriodDays, policy.suspensionThresholdCentavos],
      )).rows[0] as Row;
      const agingRow: { bucket: AgingBucket; invoiceCount: number; totalCentavos: number }[] = [
        { bucket: 'CURRENT', invoiceCount: aging.currentCount as number, totalCentavos: money(aging.currentCentavos) },
        { bucket: 'D1_30', invoiceCount: aging.d1Count as number, totalCentavos: money(aging.d1Centavos) },
        { bucket: 'D31_60', invoiceCount: aging.d2Count as number, totalCentavos: money(aging.d2Centavos) },
        { bucket: 'D61_90', invoiceCount: aging.d3Count as number, totalCentavos: money(aging.d3Centavos) },
        { bucket: 'D90_PLUS', invoiceCount: aging.d4Count as number, totalCentavos: money(aging.d4Centavos) },
      ];
      const current = money(totals.currentCentavos);
      const arrears = money(totals.arrearsCentavos);
      // The published contract carries exactly five buckets, and every open invoice lands in
      // precisely one of them, so this is a check rather than a calculation.
      if (agingRow.length !== agingBucketValues.length) throw new Error('The aging report must publish every bucket.');
      return {
        asOf, dataAsOf: today(),
        currentReceivableCentavos: current,
        overdueReceivableCentavos: arrears,
        totalReceivableCentavos: current + arrears,
        subscriberCount: accounts.accountCount as number,
        overdueSubscriberCount: accounts.overdueSubscriberCount as number,
        followUpCount: accounts.followUpCount as number,
        suspensionCandidateCount: accounts.suspensionCandidateCount as number,
        aging: agingRow,
      };
    } finally { client.release(); }
  }

  /** The overdue worklist, with every filter the laboratory sheet asks for. */
  async list(token: string, raw: unknown): Promise<ReceivableList> {
    await this.actor(token, 'receivable.view');
    const input = parse(ReceivableQuery, raw);
    const asOf = input.asOf ?? today();
    const client = await this.auth.pool.connect();
    try {
      const policy = await this.policy(client);
      const conditions: string[] = ['1=1'];
      const values: unknown[] = [asOf];
      if (input.collectorId) { values.push(input.collectorId); conditions.push(`sa.collector_id=$${values.length}`); }
      if (input.areaId) { values.push(input.areaId); conditions.push(`sa.area_id=$${values.length}`); }
      if (input.planId) { values.push(input.planId); conditions.push(`sa.plan_id=$${values.length}`); }
      if (input.serviceType) { values.push(input.serviceType); conditions.push(`p.service_type=$${values.length}`); }
      const rows = (await client.query(`${this.receivableSelect} WHERE ${conditions.join(' AND ')}`, values)).rows as Row[];
      const projected = rows
        .map((row) => this.project(row, asOf, policy))
        // By default only overdue accounts are listed, because that list is a follow-up
        // worklist; `includeCurrent` widens it to every account still owing something.
        .filter((row) => input.includeCurrent ? row.currentCentavos + row.arrearsCentavos > 0 : row.arrearsCentavos > 0)
        .filter((row) => !input.bucket || row.bucket === input.bucket)
        .filter((row) => input.minOverdueDays === undefined || row.overdueDays >= input.minOverdueDays)
        // Most delinquent first, then the largest arrears: the order a collector works in.
        .sort((a, b) => b.overdueDays - a.overdueDays || b.arrearsCentavos - a.arrearsCentavos || a.serviceCode.localeCompare(b.serviceCode));
      const start = (input.page - 1) * input.perPage;
      return { asOf, items: projected.slice(start, start + input.perPage), total: projected.length, page: input.page, perPage: input.perPage };
    } finally { client.release(); }
  }

  /** The arrears of one account as they stand, which is what a suspension is judged on. */
  private async accountAsOf(client: Client, serviceAccountId: string, asOf: string, policy: ServicePolicy) {
    const row = (await client.query(`${this.receivableSelect} WHERE sa.id=$2`, [asOf, serviceAccountId])).rows[0] as Row | undefined;
    if (!row) return null;
    return this.project(row, asOf, policy);
  }

  // -------------------------------------------------------------- suspensions

  private suspensionColumns = `su.id,su.suspension_number AS "suspensionNumber",su.service_account_id AS "serviceAccountId",
    sa.code AS "serviceCode",s.code AS "subscriberCode",s.name AS "subscriberName",p.code AS "planCode",p.service_type AS "serviceType",
    coalesce(sa.installation_address,'') AS "address",sa.area_id AS "areaId",coalesce(ca.name,'') AS "areaName",
    sa.collector_id AS "collectorId",coalesce(cl.name,'') AS "collectorName",su.status,su.reason,su.notes,
    to_char(su.effective_date,'YYYY-MM-DD') AS "effectiveDate",su.grace_period_days AS "gracePeriodDays",
    su.threshold_centavos AS "thresholdCentavos",su.arrears_at_suspension_centavos AS "arrearsAtSuspensionCentavos",
    su.months_unpaid_at_suspension AS "monthsUnpaidAtSuspension",su.approved_by AS "approvedBy",au.display_name AS "approvedName",
    su.created_at AS "createdAt",su.lifted_at AS "liftedAt",lu.display_name AS "liftedByName",
    rc.id AS "reconnectionId",rc.reconnection_number AS "reconnectionNumber",rc.status AS "reconnectionStatus",
    coalesce(rc.fee_centavos,0)::int AS "reconnectionFeeCentavos",
    to_char(rc.requested_at,'YYYY-MM-DD') AS "reconnectionRequestDate",
    to_char(rc.completed_at,'YYYY-MM-DD') AS "reconnectionCompletedDate",
    rc.technician_id AS "technicianId",tu.display_name AS "technicianName"`;

  private suspensionFrom = `FROM suspensions su
    JOIN service_accounts sa ON sa.id=su.service_account_id
    JOIN subscribers s ON s.id=sa.subscriber_id
    JOIN service_plans p ON p.id=sa.plan_id
    LEFT JOIN collection_areas ca ON ca.id=sa.area_id
    LEFT JOIN collectors cl ON cl.id=sa.collector_id
    JOIN users au ON au.id=su.approved_by
    LEFT JOIN users lu ON lu.id=su.lifted_by
    LEFT JOIN reconnections rc ON rc.suspension_id=su.id
    LEFT JOIN users tu ON tu.id=rc.technician_id`;

  private present(row: Row): Suspension {
    return {
      ...row,
      createdAt: new Date(row.createdAt as string).toISOString(),
      // The contract reports a date, so a lifted document answers with the day it was lifted
      // rather than a timestamp the desktop would have to reformat.
      liftedAt: row.liftedAt ? new Date(row.liftedAt as string).toISOString().slice(0, 10) : null,
      reconnectionFeeCentavos: (row.reconnectionFeeCentavos as number) ?? 0,
      reconnectionRequestDate: (row.reconnectionRequestDate as string) ?? null,
      reconnectionCompletedDate: (row.reconnectionCompletedDate as string) ?? null,
      technicianId: (row.technicianId as string) ?? null,
      technicianName: (row.technicianName as string) ?? null,
    } as Suspension;
  }

  async listSuspensions(token: string, raw: unknown): Promise<SuspensionList> {
    await this.actor(token, 'service.control');
    const input = parse(SuspensionQuery, raw);
    const conditions: string[] = ['1=1'];
    const values: unknown[] = [];
    if (input.status) { values.push(input.status); conditions.push(`su.status=$${values.length}`); }
    if (input.collectorId) { values.push(input.collectorId); conditions.push(`sa.collector_id=$${values.length}`); }
    if (input.areaId) { values.push(input.areaId); conditions.push(`sa.area_id=$${values.length}`); }
    const count = (await this.auth.pool.query(
      `SELECT count(DISTINCT su.id)::int AS total FROM suspensions su JOIN service_accounts sa ON sa.id=su.service_account_id WHERE ${conditions.join(' AND ')}`, values,
    )).rows[0].total as number;
    const rows = (await this.auth.pool.query(
      `SELECT ${this.suspensionColumns} ${this.suspensionFrom} WHERE ${conditions.join(' AND ')} ORDER BY su.created_at DESC,su.suspension_number DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, input.perPage, (input.page - 1) * input.perPage],
    )).rows as Row[];
    return { items: rows.map((row) => this.present(row)), total: count, page: input.page, perPage: input.perPage };
  }

  async getSuspension(token: string, id: string): Promise<Suspension> {
    await this.actor(token, 'service.control');
    const row = (await this.auth.pool.query(`SELECT ${this.suspensionColumns} ${this.suspensionFrom} WHERE su.id=$1`, [id])).rows[0] as Row | undefined;
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'That suspension does not exist.');
    return this.present(row);
  }

  /** Technicians can be assigned a reconnection, so the control screen needs to list them. */
  async listTechnicians(token: string) {
    await this.actor(token, 'service.control');
    const rows = (await this.auth.pool.query(
      `SELECT u.id,u.display_name AS "displayName",u.username FROM users u
       JOIN user_roles r ON r.user_id=u.id WHERE r.role_code='TECHNICIAN' AND u.active ORDER BY u.display_name`,
    )).rows;
    return rows;
  }

  /**
   * Suspending freezes the receivable onto the document: the arrears, the oldest unpaid due
   * date, the months unpaid and the policy in force, all as they stood on the effective date.
   * The account must be active and must actually meet the configured policy, otherwise the
   * command is refused rather than leaving a disconnection the office cannot justify.
   */
  async suspend(token: string, serviceAccountId: string, raw: unknown): Promise<Suspension> {
    const input = parse(SuspendServiceInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await client.query('BEGIN');
      await markServiceControlTransaction(client);
      const actor = await this.actor(token, 'service.control', client);
      const policy = await this.policy(client);
      const asOf = input.effectiveDate ?? today();
      // One account, one writer: the account row is locked for the rest of the transaction,
      // so two clerks cannot both open a suspension on the same service.
      const account = (await client.query(
        `SELECT status FROM service_accounts WHERE id=$1 FOR UPDATE`, [serviceAccountId],
      )).rows[0] as Row | undefined;
      if (!account) throw new ApiError(404, 'NOT_FOUND', 'That service account does not exist.');
      if (account.status !== 'ACTIVE') throw conflict(`Only an active service account can be suspended; this one is ${account.status}.`);
      const projected = await this.accountAsOf(client, serviceAccountId, asOf, policy);
      if (!projected) throw new ApiError(404, 'NOT_FOUND', 'That service account does not exist.');
      const decision = qualifiesForSuspension({
        arrearsCentavos: projected.arrearsCentavos, oldestUnpaidDueDate: projected.oldestUnpaidDueDate,
        asOf, thresholdCentavos: policy.suspensionThresholdCentavos, gracePeriodDays: policy.gracePeriodDays,
      });
      if (projected.arrearsCentavos === 0) throw conflict('This account has no overdue balance, so there is nothing to suspend for.');
      if (!decision.eligible) {
        throw conflict(decision.reason === 'BELOW_THRESHOLD'
          ? `The account owes ${pesos(projected.arrearsCentavos)}, which is below the configured suspension threshold of ${pesos(policy.suspensionThresholdCentavos)}.`
          : `The oldest unpaid invoice is ${decision.overdueDays} days overdue, inside the ${policy.gracePeriodDays}-day grace period.`);
      }
      const number = await this.nextNumber(client, 'SUSPENSION', new Date(`${asOf}T00:00:00Z`).getUTCFullYear(), formatSuspensionNumber);
      const suspensionId = (await client.query(
        `INSERT INTO suspensions(suspension_number,service_account_id,status,reason,notes,effective_date,grace_period_days,
          threshold_centavos,arrears_at_suspension_centavos,months_unpaid_at_suspension,approved_by)
         VALUES($1,$2,'ACTIVE',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [number, serviceAccountId, input.reason, input.notes, asOf, policy.gracePeriodDays, policy.suspensionThresholdCentavos,
          projected.arrearsCentavos, projected.monthsUnpaid, actor.id],
      )).rows[0].id as string;
      // The account is suspended and the history entry is written before the transaction
      // commits; the database refuses the commit if the history entry is missing.
      await this.setStatus(client, serviceAccountId, 'SUSPENDED');
      await this.history(client, serviceAccountId, 'SUSPENDED', `${number}: ${input.reason}`, input.reason, projected.arrearsCentavos, asOf, actor.id);
      await this.audit(client, actor.id, 'service.suspend', suspensionId, { serviceAccountId, number, effectiveDate: asOf, arrearsCentavos: projected.arrearsCentavos, monthsUnpaid: projected.monthsUnpaid, reason: input.reason });
      await client.query('COMMIT');
      return await this.getSuspension(token, suspensionId);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  /**
   * Lifting a disconnection requires a reason, because it is never quietly undone: the
   * suspension is kept and marked LIFTED, and the account goes back to ACTIVE on the same
   * billing basis, so no rate or cycle is rewritten by a disconnection being resolved.
   */
  async lift(token: string, id: string, raw: unknown): Promise<Suspension> {
    const input = parse(LiftSuspensionInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await client.query('BEGIN');
      await markServiceControlTransaction(client);
      const actor = await this.actor(token, 'service.control', client);
      const row = (await client.query(
        `SELECT id,service_account_id AS "serviceAccountId",suspension_number AS "suspensionNumber",status
         FROM suspensions WHERE id=$1 FOR UPDATE`, [id],
      )).rows[0] as Row | undefined;
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'That suspension does not exist.');
      if (row.status !== 'ACTIVE') throw conflict(`This suspension is already ${row.status}.`);
      await client.query(`UPDATE suspensions SET status='LIFTED',lifted_at=now(),lifted_by=$1 WHERE id=$2`, [actor.id, id]);
      await this.setStatus(client, row.serviceAccountId as string, 'ACTIVE');
      await this.history(client, row.serviceAccountId as string, 'LIFTED', `${row.suspensionNumber} lifted: ${input.reason}`, input.reason, 0, today(), actor.id);
      await this.audit(client, actor.id, 'service.lift', id, { serviceAccountId: row.serviceAccountId, reason: input.reason });
      await client.query('COMMIT');
      return await this.getSuspension(token, id);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  // -------------------------------------------------------------- reconnection

  /**
   * A reconnection may only be raised once the arrears are actually cleared: that is the
   * whole point of the workflow. The fee comes from the policy unless the clerk states it,
   * and the request may be raised with or without a technician already assigned.
   */
  async requestReconnection(token: string, suspensionId: string, raw: unknown): Promise<Suspension> {
    const input = parse(RequestReconnectionInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await client.query('BEGIN');
      await markServiceControlTransaction(client);
      const actor = await this.actor(token, 'service.control', client);
      const policy = await this.policy(client);
      const asOf = input.requestedOn ?? today();
      const suspension = (await client.query(
        `SELECT id,service_account_id AS "serviceAccountId",suspension_number AS "suspensionNumber",status
         FROM suspensions WHERE id=$1 FOR UPDATE`, [suspensionId],
      )).rows[0] as Row | undefined;
      if (!suspension) throw new ApiError(404, 'NOT_FOUND', 'That suspension does not exist.');
      if (suspension.status !== 'ACTIVE') throw conflict('Reconnection can only follow a suspension that is still in force.');
      const technicianId = input.technicianId ? await this.technician(client, input.technicianId) : null;
      const projected = await this.accountAsOf(client, suspension.serviceAccountId as string, asOf, policy);
      if (!projected) throw new ApiError(404, 'NOT_FOUND', 'That service account does not exist.');
      const blocked = reconnectionBlockedBy(projected.arrearsCentavos + projected.currentCentavos);
      if (blocked) throw conflict(`${blocked} (${pesos(projected.arrearsCentavos + projected.currentCentavos)} still open.)`);
      const feeCentavos = input.feeCentavos ?? policy.reconnectionFeeCentavos;
      const number = await this.nextNumber(client, 'RECONNECTION', new Date(`${asOf}T00:00:00Z`).getUTCFullYear(), formatReconnectionNumber);
      const reconnectionId = (await client.query(
        `INSERT INTO reconnections(reconnection_number,service_account_id,suspension_id,status,fee_centavos,requested_by,technician_id,notes,assigned_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $7::uuid IS NULL THEN NULL ELSE now() END) RETURNING id`,
        [number, suspension.serviceAccountId, suspensionId, technicianId ? 'ASSIGNED' : 'REQUESTED', feeCentavos, actor.id, technicianId, input.notes],
      )).rows[0].id as string;
      await this.history(client, suspension.serviceAccountId as string, 'RECONNECTION_REQUESTED',
        `${number} raised${technicianId ? ' and assigned to a technician' : ''}`, input.notes || `Reconnection requested against ${suspension.suspensionNumber}`, feeCentavos, asOf, actor.id);
      await this.audit(client, actor.id, 'service.reconnection.request', reconnectionId, { number, suspensionId, feeCentavos, technicianId });
      await client.query('COMMIT');
      return await this.getSuspension(token, suspensionId);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async assignTechnician(token: string, suspensionId: string, raw: unknown): Promise<Suspension> {
    const input = parse(AssignTechnicianInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await client.query('BEGIN');
      await markServiceControlTransaction(client);
      const actor = await this.actor(token, 'service.control', client);
      const reconnection = (await client.query(
        `SELECT rc.id,rc.reconnection_number AS "reconnectionNumber",rc.status,rc.service_account_id AS "serviceAccountId"
         FROM reconnections rc WHERE rc.suspension_id=$1 FOR UPDATE`, [suspensionId],
      )).rows[0] as Row | undefined;
      if (!reconnection) throw new ApiError(404, 'NOT_FOUND', 'This suspension has no reconnection to assign.');
      if (reconnection.status !== 'REQUESTED') throw conflict(`A technician cannot be assigned to a ${String(reconnection.status).toLowerCase()} reconnection.`);
      const technicianId = await this.technician(client, input.technicianId);
      await client.query(
        `UPDATE reconnections SET technician_id=$1,status='ASSIGNED',assigned_at=now(),
           notes=case when notes='' then $2 else notes||E'\n'||$2 end WHERE id=$3`,
        [technicianId, input.notes, reconnection.id],
      );
      await this.history(client, reconnection.serviceAccountId as string, 'RECONNECTION_ASSIGNED',
        `${reconnection.reconnectionNumber} assigned to a technician`, input.notes, 0, today(), actor.id);
      await this.audit(client, actor.id, 'service.reconnection.assign', reconnection.id as string, { suspensionId, technicianId });
      await client.query('COMMIT');
      return await this.getSuspension(token, suspensionId);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  /**
   * Completing a reconnection is what restores the service: the reconnection is dated,
   * the suspension it answers is lifted and the account returns to ACTIVE, so the
   * disconnection and its resolution both stay visible in the service history.
   */
  async completeReconnection(token: string, suspensionId: string, raw: unknown): Promise<Suspension> {
    const input = parse(CompleteReconnectionInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await client.query('BEGIN');
      await markServiceControlTransaction(client);
      const actor = await this.actor(token, 'service.control', client);
      const completedOn = input.completedOn ?? today();
      const reconnection = (await client.query(
        `SELECT rc.id,rc.reconnection_number AS "reconnectionNumber",rc.status,rc.service_account_id AS "serviceAccountId",rc.suspension_id AS "suspensionId"
         FROM reconnections rc WHERE rc.suspension_id=$1 FOR UPDATE`, [suspensionId],
      )).rows[0] as Row | undefined;
      if (!reconnection) throw new ApiError(404, 'NOT_FOUND', 'This suspension has no reconnection.');
      if (reconnection.status !== 'ASSIGNED') throw conflict(`Only an assigned reconnection can be completed; this one is ${String(reconnection.status).toLowerCase()}.`);
      await client.query(
        `UPDATE reconnections SET status='COMPLETED',completed_at=$1::date,
           notes=case when notes='' then $2 else notes||E'\n'||$2 end WHERE id=$3`,
        [completedOn, input.notes, reconnection.id],
      );
      const suspension = (await client.query(
        `SELECT status,suspension_number AS "suspensionNumber" FROM suspensions WHERE id=$1 FOR UPDATE`, [reconnection.suspensionId],
      )).rows[0] as Row;
      if (suspension.status === 'ACTIVE') {
        await client.query(`UPDATE suspensions SET status='LIFTED',lifted_at=now(),lifted_by=$1 WHERE id=$2`, [actor.id, reconnection.suspensionId]);
      }
      await this.setStatus(client, reconnection.serviceAccountId as string, 'ACTIVE');
      await this.history(client, reconnection.serviceAccountId as string, 'RECONNECTION_COMPLETED',
        `${reconnection.reconnectionNumber} completed and ${suspension.suspensionNumber} lifted`, input.notes, 0, completedOn, actor.id);
      await this.audit(client, actor.id, 'service.reconnection.complete', reconnection.id as string, { suspensionId, completedOn });
      await client.query('COMMIT');
      return await this.getSuspension(token, suspensionId);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  // -------------------------------------------------------------- history

  /** A technician may only be assigned work they can actually do, so the role is checked. */
  private async technician(client: Client, id: string) {
    const row = (await client.query(
      `SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=$1 AND u.active AND r.role_code='TECHNICIAN'`, [id],
    )).rows[0] as { id: string } | undefined;
    if (!row) throw invalid('That technician is missing or is not an active technician.', { technicianId: ['Choose an active technician.'] });
    return row.id;
  }

  private async setStatus(client: Client, serviceAccountId: string, status: string) {
    return client.query(`UPDATE service_accounts SET status=$2,version=version+1 WHERE id=$1 AND status IS DISTINCT FROM $2`, [serviceAccountId, status]);
  }

  /**
   * A control change is appended to the same master history the technician screen already
   * reads, so a disconnection shows up in the service history without a second timeline to
   * keep in step with it.
   */
  private async history(client: Client, serviceAccountId: string, eventType: ServiceControlEvent['eventType'], summary: string, reason: string, amountCentavos: number, effectiveDate: string, actorId: string) {
    return client.query(
      `INSERT INTO master_history(resource,record_id,version,snapshot,reason,actor_id)
       SELECT 'services',$1::uuid,(SELECT coalesce(max(version),0)+1 FROM master_history WHERE resource='services' AND record_id=$1::uuid),
         jsonb_build_object('status',sa.status,'controlEvent',$2::text,'summary',$3::text,'effectiveDate',$4::text,'amountCentavos',$5::int),
         $6,$7::uuid FROM service_accounts sa WHERE sa.id=$1::uuid`,
      [serviceAccountId, eventType, summary, effectiveDate, amountCentavos, reason, actorId],
    );
  }

  /** The control events for one service account, read from the history itself. */
  async controlHistory(token: string, serviceAccountId: string): Promise<ServiceControlEvent[]> {
    await this.actor(token, 'service.control');
    const rows = (await this.auth.pool.query(
      `SELECT h.id,(h.snapshot->>'controlEvent') AS "eventType",coalesce(h.snapshot->>'summary','') AS "summary",h.reason,
         coalesce((h.snapshot->>'amountCentavos')::int,0)::int AS "amountCentavos",
         coalesce(h.snapshot->>'effectiveDate',to_char(h.created_at,'YYYY-MM-DD')) AS "effectiveDate",
         u.display_name AS "actorName",h.created_at AS "createdAt"
       FROM master_history h JOIN users u ON u.id=h.actor_id
       WHERE h.resource='services' AND h.record_id=$1 AND h.snapshot->>'controlEvent' IS NOT NULL
       ORDER BY h.created_at DESC,h.version DESC`, [serviceAccountId],
    )).rows as Row[];
    return rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt as string).toISOString() })) as ServiceControlEvent[];
  }
}
