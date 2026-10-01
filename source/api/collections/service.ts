import {
  BatchQuery, CloseBatchInput, CreateBatchInput, ReconcileBatchInput, RemittanceInput, SubmitBatchInput,
  batchAccountStatus, batchSummary, canTransition, formatBatchNumber, formatRemittanceNumber, isCollectable,
  reconcileCash, routeAccountLimit, routeSheetTotals,
  type Batch, type BatchAccount, type BatchDetail, type BatchList, type RouteSheet,
} from '../../shared/collections';
import { ApiError } from '../auth/errors';
import type { AuthService } from '../auth/service';
import { parse } from '../master-data/service';
import { lock, type Client } from '../billing/ledger';

type Permission = 'collection.view' | 'collection.manage' | 'collection.reconcile';
type Row = Record<string, unknown>;
const conflict = (message: string) => new ApiError(409, 'CONFLICT', message);
const invalid = (message: string, fields?: Record<string, string[]>) => new ApiError(422, 'VALIDATION', message, fields);
const forbidden = (message: string) => new ApiError(403, 'FORBIDDEN', message);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Marks the transaction as one that may move a collection batch. The database guard requires
 * this flag, so a state change made by raw SQL is refused; a payment that is recorded onto a
 * batch sets it too, because that command may also start the route.
 */
export const markCollectionTransaction = (client: Client) => client.query("SELECT set_config('bcis.collection','on',true)");

// The batch header, and the joins that resolve the collector, the area and the two users whose
// names a reconciliation report has to show.
const batchColumns = `b.id,b.batch_number AS "batchNumber",b.status,b.collector_id AS "collectorId",c.name AS "collectorName",
  b.area_id AS "areaId",a.name AS "areaName",to_char(b.collection_date,'YYYY-MM-DD') AS "collectionDate",b.notes,
  b.started_at AS "startedAt",b.submitted_at AS "submittedAt",b.remitted_at AS "remittedAt",b.reconciled_at AS "reconciledAt",
  b.reconciliation_notes AS "reconciliationNotes",b.closed_at AS "closedAt",b.created_by AS "createdBy",
  cu.display_name AS "createdName",b.created_at AS "createdAt",rv.display_name AS "reconciledName"`;
const batchFrom = `FROM collection_batches b
  JOIN collectors c ON c.id=b.collector_id
  JOIN collection_areas a ON a.id=b.area_id
  JOIN users cu ON cu.id=b.created_by
  LEFT JOIN users rv ON rv.id=b.reconciled_by`;

/**
 * Every collected figure comes from the payments that carry the batch, so a batch can never
 * hold a total of its own that disagrees with the ledger. A reversal is subtracted, so money
 * taken back stops counting, and a claim awaiting confirmation is reported apart from
 * collected money because it has not been collected yet.
 */
const figuresCte = `figures AS (
  SELECT b.id,
    coalesce((SELECT sum(ba.total_due_centavos) FROM batch_accounts ba WHERE ba.batch_id=b.id),0)::int AS "expectedReceivableCentavos",
    coalesce(sum(p.amount_centavos) FILTER (WHERE p.status='POSTED' AND p.direction='PAYMENT' AND p.method='CASH'),0)::int
      - coalesce(sum(p.amount_centavos) FILTER (WHERE p.status='POSTED' AND p.direction='REVERSAL' AND p.method='CASH'),0)::int AS "cashCollectedCentavos",
    coalesce(sum(p.amount_centavos) FILTER (WHERE p.status='POSTED' AND p.direction='PAYMENT' AND p.method<>'CASH'),0)::int
      - coalesce(sum(p.amount_centavos) FILTER (WHERE p.status='POSTED' AND p.direction='REVERSAL' AND p.method<>'CASH'),0)::int AS "nonCashCollectedCentavos",
    coalesce(sum(p.amount_centavos) FILTER (WHERE p.status='PENDING'),0)::int AS "pendingClaimCentavos"
  FROM collection_batches b LEFT JOIN payments p ON p.collection_batch_id=b.id
  WHERE b.id IN (SELECT id FROM page) GROUP BY b.id
)`;

/** What each account on the route brought in, net of anything that was later reversed. */
const collectedCte = `collected AS (
  SELECT p.collection_batch_id AS batch_id,p.subscriber_id,
    coalesce(sum(p.amount_centavos) FILTER (WHERE p.status='POSTED' AND p.direction='PAYMENT'),0)::int
      - coalesce(sum(p.amount_centavos) FILTER (WHERE p.status='POSTED' AND p.direction='REVERSAL'),0)::int AS amount
  FROM payments p WHERE p.collection_batch_id IN (SELECT id FROM page) GROUP BY p.collection_batch_id,p.subscriber_id
)`;

// The list folds the frozen route up into one row per batch. The detail screen folds the same
// route with shared/collections.ts, and tests/integration/collections.test.ts holds both
// readings of the same route to the same figures.
const progressCte = `progress AS (
  SELECT ba.batch_id,
    count(*)::int AS "accountCount",
    count(*) FILTER (WHERE coalesce(c.amount,0)<=0)::int AS "accountsUnpaid",
    count(*) FILTER (WHERE coalesce(c.amount,0)>0 AND coalesce(c.amount,0)<ba.total_due_centavos)::int AS "accountsPartial",
    count(*) FILTER (WHERE coalesce(c.amount,0)=ba.total_due_centavos)::int AS "accountsCollected",
    coalesce(sum(greatest(ba.total_due_centavos-coalesce(c.amount,0),0)),0)::int AS "uncollectedCentavos",
    coalesce(sum(greatest(coalesce(c.amount,0)-ba.total_due_centavos,0)),0)::int AS "overCollectedCentavos"
  FROM batch_accounts ba LEFT JOIN collected c ON c.batch_id=ba.batch_id AND c.subscriber_id=ba.subscriber_id
  WHERE ba.batch_id IN (SELECT id FROM page) GROUP BY ba.batch_id
)`;

const remittanceCte = `remittance AS (
  SELECT r.*,ru.display_name AS "recordedName" FROM batch_remittances r JOIN users ru ON ru.id=r.recorded_by
  WHERE r.batch_id IN (SELECT id FROM page)
)`;

const progressColumns = `coalesce(g."accountCount",0) AS "accountCount",coalesce(g."accountsCollected",0) AS "accountsCollected",
  coalesce(g."accountsPartial",0) AS "accountsPartial",coalesce(g."accountsUnpaid",0) AS "accountsUnpaid",
  coalesce(g."uncollectedCentavos",0) AS "uncollectedCentavos",coalesce(g."overCollectedCentavos",0) AS "overCollectedCentavos"`;

// A batch with no remittance is not balanced: nothing has been counted yet.
const remittanceColumns = `coalesce(rm.shortage_centavos,0) AS "shortageCentavos",coalesce(rm.overage_centavos,0) AS "overageCentavos",
  coalesce(rm.balanced,false) AS "balanced",to_char(rm.remitted_on,'YYYY-MM-DD') AS "remittedOn",rm.remittance_number AS "remittanceNumber"`;

const detailColumns = `${batchColumns},f."expectedReceivableCentavos",f."cashCollectedCentavos",f."nonCashCollectedCentavos",
  f."pendingClaimCentavos",${progressColumns},${remittanceColumns},
  (SELECT coalesce(jsonb_agg(jsonb_build_object('id',ba.id,'subscriberId',ba.subscriber_id,'subscriberCode',ba.subscriber_code,
    'subscriberName',ba.subscriber_name,'address',ba.address,'currentBillCentavos',ba.current_bill_centavos,
    'arrearsCentavos',ba.arrears_centavos,'totalDueCentavos',ba.total_due_centavos,'collectedCentavos',coalesce(c.amount,0))
    ORDER BY ba.subscriber_code),'[]')
   FROM batch_accounts ba LEFT JOIN collected c ON c.batch_id=ba.batch_id AND c.subscriber_id=ba.subscriber_id
   WHERE ba.batch_id=b.id) AS accounts,
  (SELECT jsonb_build_object('id',rm.id,'batchId',rm.batch_id,'remittanceNumber',rm.remittance_number,'remittedOn',
    to_char(rm.remitted_on,'YYYY-MM-DD'),'expectedCashCentavos',rm.expected_cash_centavos,'cashCentavos',rm.cash_centavos,
    'shortageCentavos',rm.shortage_centavos,'overageCentavos',rm.overage_centavos,'balanced',rm.balanced,'notes',rm.notes,
    'recordedBy',rm.recorded_by,'recordedName',rm."recordedName",'createdAt',rm.created_at)
   FROM remittance rm WHERE rm.batch_id=b.id) AS remittance`;

/** The header, the route and the remittance, assembled from one consistent snapshot. */
function present(row: Row): BatchDetail {
  const accounts = ((row.accounts as Row[]) ?? []).map((account) => ({
    ...account,
    status: batchAccountStatus(account.totalDueCentavos as number, account.collectedCentavos as number),
  })) as unknown as BatchAccount[];
  const summary = batchSummary(accounts, {
    expectedReceivableCentavos: row.expectedReceivableCentavos as number,
    cashCollectedCentavos: row.cashCollectedCentavos as number,
    nonCashCollectedCentavos: row.nonCashCollectedCentavos as number,
    pendingClaimCentavos: row.pendingClaimCentavos as number,
  });
  return { ...row, ...summary, accounts, remittance: (row.remittance as BatchDetail['remittance']) ?? null } as unknown as BatchDetail;
}

/** A batch without its route, for the list, where the same figures are folded in SQL. */
function withoutRoute(row: Row): Batch {
  const header = { ...row };
  delete (header as Record<string, unknown>).accounts;
  delete (header as Record<string, unknown>).remittance;
  return { ...header, totalCollectedCentavos: (row.cashCollectedCentavos as number) + (row.nonCashCollectedCentavos as number) } as unknown as Batch;
}

export class CollectionService {
  constructor(private auth: AuthService) {}

  private actor(token: string, permission: Permission, client?: Client) {
    return this.auth.authorize(token, permission, client);
  }

  /**
   * A batch state change is only ever made from here. The transaction local
   * `bcis.collection` flag is what the database guard requires, so a direct SQL update
   * outside this service is refused.
   */
  private async begin(client: Client) {
    await client.query('BEGIN');
    await markCollectionTransaction(client);
  }

  private audit(client: Client, actorId: string, action: string, subjectId: string, details: unknown) {
    return client.query('INSERT INTO audit_logs(actor_id,action,subject_id,details) VALUES($1,$2,$3,$4)', [actorId, action, subjectId, JSON.stringify(details)]);
  }

  // ------------------------------------------------------------- reading

  async list(token: string, raw: unknown): Promise<BatchList> {
    await this.actor(token, 'collection.view');
    const query = parse(BatchQuery, raw);
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (query.q) {
      values.push(`%${query.q.replace(/[\\%_]/g, '\\$&')}%`);
      conditions.push(`(b.batch_number ILIKE $${values.length} OR c.name ILIKE $${values.length} OR a.name ILIKE $${values.length})`);
    }
    if (query.status) { values.push(query.status); conditions.push(`b.status=$${values.length}`); }
    if (query.collectorId) { values.push(query.collectorId); conditions.push(`b.collector_id=$${values.length}`); }
    if (query.areaId) { values.push(query.areaId); conditions.push(`b.area_id=$${values.length}`); }
    const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
    // One statement gives the count and the page a consistent snapshot, even when the
    // requested page is empty.
    const result = await this.auth.pool.query(
      `WITH filtered AS (SELECT b.id FROM collection_batches b JOIN collectors c ON c.id=b.collector_id JOIN collection_areas a ON a.id=b.area_id WHERE 1=1 ${where}),
         page AS (SELECT id FROM filtered ORDER BY (SELECT collection_date FROM collection_batches WHERE id=filtered.id) DESC,id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}),
         ${figuresCte},${collectedCte},${progressCte},${remittanceCte},
         listed AS (SELECT ${batchColumns},f."expectedReceivableCentavos",f."cashCollectedCentavos",f."nonCashCollectedCentavos",
           f."pendingClaimCentavos",${progressColumns},${remittanceColumns}
           ${batchFrom}
           LEFT JOIN figures f ON f.id=b.id LEFT JOIN progress g ON g.batch_id=b.id LEFT JOIN remittance rm ON rm.batch_id=b.id
           WHERE b.id IN (SELECT id FROM page))
       SELECT coalesce((SELECT jsonb_agg(to_jsonb(document)) FROM listed document),'[]') AS items,
         (SELECT count(*)::int FROM filtered) AS total`,
      values.concat([query.perPage, (query.page - 1) * query.perPage]),
    );
    return { items: ((result.rows[0].items as Row[]) ?? []).map(withoutRoute), total: result.rows[0].total as number, page: query.page, perPage: query.perPage };
  }

  async get(token: string, id: string): Promise<BatchDetail> {
    await this.actor(token, 'collection.view');
    return this.read(id);
  }

  /** The printable route sheet is a projection of the same read, so it cannot drift from it. */
  async routeSheet(token: string, id: string): Promise<RouteSheet> {
    await this.actor(token, 'collection.view');
    const detail = await this.read(id);
    return {
      batchNumber: detail.batchNumber, collectionDate: detail.collectionDate, status: detail.status,
      collectorName: detail.collectorName, areaName: detail.areaName, accounts: detail.accounts,
      totals: routeSheetTotals(detail), generatedAt: new Date().toISOString(),
    };
  }

  // ------------------------------------------------------------- opening a route

  /**
   * Freezes the day's route. Every active account in the area with an open balance is copied
   * in with the amounts that were due that day, split into the newest bill and the arrears
   * behind it, so the printed sheet is the same document the office later reconciles.
   */
  async create(token: string, raw: unknown): Promise<BatchDetail> {
    const input = parse(CreateBatchInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await this.begin(client);
      const actor = await this.actor(token, 'collection.manage', client);
      if (input.collectionDate > today()) throw invalid('A collection batch cannot be dated in the future.', { collectionDate: ['Choose today or an earlier date.'] });

      const area = (await client.query('SELECT id,active FROM collection_areas WHERE id=$1', [input.areaId])).rows[0] as { id: string; active: boolean } | undefined;
      if (!area) throw new ApiError(404, 'NOT_FOUND', 'Collection area not found.');
      if (!area.active) throw conflict('A route cannot be opened for an inactive collection area.');
      const collector = (await client.query('SELECT id,active FROM collectors WHERE id=$1', [input.collectorId])).rows[0] as { id: string; active: boolean } | undefined;
      if (!collector) throw new ApiError(404, 'NOT_FOUND', 'Collector not found.');
      if (!collector.active) throw conflict('A route cannot be opened for an inactive collector.');

      const existing = (await client.query(
        'SELECT batch_number FROM collection_batches WHERE collector_id=$1 AND area_id=$2 AND collection_date=$3',
        [input.collectorId, input.areaId, input.collectionDate],
      )).rows[0] as { batch_number: string } | undefined;
      if (existing) throw conflict(`${existing.batch_number} already covers this collector and area on that date.`);

      // The same set the route is built from, so the cap and the refusal of an empty route
      // are both decided before anything is written.
      const scope = input.subscriberIds ? 'AND s.id = ANY($2::uuid[])' : '';
      const candidates = (await client.query(
        `SELECT s.id,s.code FROM subscribers s WHERE s.area_id=$1 AND s.status='ACTIVE' ${scope}
           AND EXISTS (SELECT 1 FROM invoices i WHERE i.subscriber_id=s.id AND i.status NOT IN ('DRAFT','VOID') AND i.balance_centavos>0)
         ORDER BY s.code`,
        [input.areaId, ...(input.subscriberIds ? [input.subscriberIds] : [])],
      )).rows as { id: string; code: string }[];

      if (input.subscriberIds) {
        const found = new Set(candidates.map((row) => row.id));
        const missing = input.subscriberIds.filter((id) => !found.has(id));
        if (missing.length) {
          throw invalid('Some chosen accounts are not active accounts of this collection area with an open balance.', {
            subscriberIds: [`${missing.length} account(s) are not collectable on this route.`],
          });
        }
      }
      if (candidates.length === 0) throw conflict('No active account in this area has an open balance, so there is no route to collect.');
      if (candidates.length > routeAccountLimit) {
        throw conflict(`This area has ${candidates.length} accounts with an open balance. Split the route into batches of ${routeAccountLimit} or fewer.`);
      }

      const year = Number(input.collectionDate.slice(0, 4));
      const batchNumber = await this.nextNumber(client, 'BATCH', year, formatBatchNumber);
      const batchId = (await client.query(
        `INSERT INTO collection_batches(batch_number,status,collector_id,area_id,collection_date,notes,created_by)
         VALUES($1,'OPEN',$2,$3,$4,$5,$6) RETURNING id`,
        [batchNumber, input.collectorId, input.areaId, input.collectionDate, input.notes, actor.id],
      )).rows[0].id as string;

      // The newest open bill is the current one and everything older behind it is arrears,
      // which is how a subscriber reads their own statement.
      await client.query(
        `WITH open AS (
           SELECT i.subscriber_id,i.balance_centavos,
             row_number() OVER (PARTITION BY i.subscriber_id ORDER BY i.due_date DESC,i.issue_date DESC,i.id DESC) AS rank
           FROM invoices i
           WHERE i.status NOT IN ('DRAFT','VOID') AND i.balance_centavos>0
             AND i.subscriber_id IN (SELECT id FROM subscribers WHERE area_id=$2 AND status='ACTIVE' ${input.subscriberIds ? 'AND id = ANY($3::uuid[])' : ''})
         ), split AS (
           SELECT subscriber_id,
             coalesce(sum(balance_centavos) FILTER (WHERE rank=1),0)::int AS current_bill,
             coalesce(sum(balance_centavos) FILTER (WHERE rank>1),0)::int AS arrears
           FROM open GROUP BY subscriber_id
         )
         INSERT INTO batch_accounts(batch_id,subscriber_id,subscriber_code,subscriber_name,address,current_bill_centavos,arrears_centavos,total_due_centavos)
         SELECT $1,s.id,s.code,s.name,
           coalesce((SELECT string_agg(sa.installation_address,'; ' ORDER BY sa.installation_address) FROM service_accounts sa WHERE sa.subscriber_id=s.id AND sa.status='ACTIVE'),
             nullif(s.addresses->>0,''),''),
           sp.current_bill,sp.arrears,sp.current_bill+sp.arrears
         FROM subscribers s JOIN split sp ON sp.subscriber_id=s.id
         WHERE s.area_id=$2 AND s.status='ACTIVE' ${input.subscriberIds ? 'AND s.id = ANY($3::uuid[])' : ''}`,
        [batchId, input.areaId, ...(input.subscriberIds ? [input.subscriberIds] : [])],
      );

      const total = (await client.query('SELECT coalesce(sum(total_due_centavos),0)::int AS total FROM batch_accounts WHERE batch_id=$1', [batchId])).rows[0].total as number;
      await this.audit(client, actor.id, 'collection.batch.create', batchId, { batchNumber, areaId: input.areaId, collectorId: input.collectorId, collectionDate: input.collectionDate, accountCount: candidates.length, expectedReceivableCentavos: total });
      await client.query('COMMIT');
      return this.read(batchId);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  // ------------------------------------------------------------- lifecycle

  /** Takes the next step of the straight-line lifecycle, and refuses anything else. */
  async start(token: string, id: string): Promise<BatchDetail> {
    return this.step(token, id, 'IN_PROGRESS', 'collection.manage', 'collection.batch.start');
  }

  async submit(token: string, id: string, raw: unknown): Promise<BatchDetail> {
    const input = parse(SubmitBatchInput, raw);
    return this.step(token, id, 'SUBMITTED', 'collection.manage', 'collection.batch.submit', {
      notes: input.notes,
      // A route is frozen from here on, so a GCash claim still awaiting confirmation is
      // reported by the batch and cannot be quietly settled after submission.
      before: async (client) => {
        const pending = (await client.query(
          "SELECT count(*)::int AS count,coalesce(sum(amount_centavos),0)::int AS amount FROM payments WHERE collection_batch_id=$1 AND status='PENDING'",
          [id],
        )).rows[0] as { count: number; amount: number };
        if (pending.count > 0) {
          throw conflict(`This route still has ${pending.count} GCash claim(s) totalling PHP ${(pending.amount / 100).toFixed(2)} awaiting confirmation. Confirm them before submitting the route.`);
        }
      },
    });
  }

  /**
   * AT-07 and AT-08: the cash the collector should have handed in is frozen at the moment of
   * counting, the count is compared against it, and any difference is stored as an explicit
   * shortage or overage on the remittance. A count that does not match is never adjusted
   * away, and a batch carries exactly one remittance, so a second count is refused.
   */
  async remit(token: string, id: string, raw: unknown): Promise<BatchDetail> {
    const input = parse(RemittanceInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await this.begin(client);
      const actor = await this.actor(token, 'collection.manage', client);
      const batch = await this.locked(client, id);
      if (batch.status !== 'SUBMITTED') throw conflict('Only a submitted route can be remitted. Submit the route first.');
      if (input.remittedOn > today()) throw invalid('A remittance cannot be dated in the future.', { remittedOn: ['Choose today or an earlier date.'] });
      const counted = (await client.query('SELECT 1 FROM batch_remittances WHERE batch_id=$1', [id])).rows[0];
      if (counted) throw conflict('This route has already been counted. Reconcile the recorded remittance instead of counting it again.');

      // The batch row is held, and a collection needs this row, so the expected cash cannot
      // move between this read and the commit.
      const expected = (await client.query(
        `SELECT coalesce(sum(amount_centavos) FILTER (WHERE status='POSTED' AND direction='PAYMENT' AND method='CASH'),0)::int
           - coalesce(sum(amount_centavos) FILTER (WHERE status='POSTED' AND direction='REVERSAL' AND method='CASH'),0)::int AS cash
         FROM payments WHERE collection_batch_id=$1`, [id],
      )).rows[0].cash as number;
      const { balanced, shortageCentavos, overageCentavos } = reconcileCash(expected, input.cashCentavos);
      const year = Number(input.remittedOn.slice(0, 4));
      const remittanceNumber = await this.nextNumber(client, 'REMITTANCE', year, formatRemittanceNumber);

      await client.query(
        `INSERT INTO batch_remittances(batch_id,remittance_number,remitted_on,expected_cash_centavos,cash_centavos,shortage_centavos,overage_centavos,balanced,notes,recorded_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, remittanceNumber, input.remittedOn, expected, input.cashCentavos, shortageCentavos, overageCentavos, balanced, input.notes, actor.id],
      );
      await client.query("UPDATE collection_batches SET status='REMITTED',remitted_at=now() WHERE id=$1", [id]);
      await this.audit(client, actor.id, 'collection.batch.remit', id, {
        remittanceNumber, expectedCashCentavos: expected, cashCentavos: input.cashCentavos, shortageCentavos, overageCentavos, balanced, notes: input.notes,
      });
      await client.query('COMMIT');
      return this.read(id);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  /**
   * The second signature. The person who counted the money may not be the person who accepts
   * the count, the batch must already carry its remittance, and a written reason is required,
   * so a shortage or an overage is always explained rather than quietly closed.
   */
  async reconcile(token: string, id: string, raw: unknown): Promise<BatchDetail> {
    const input = parse(ReconcileBatchInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await this.begin(client);
      const actor = await this.actor(token, 'collection.reconcile', client);
      const batch = await this.locked(client, id);
      if (batch.status !== 'REMITTED') throw conflict('Only a remitted route can be reconciled.');
      const remittance = (await client.query('SELECT recorded_by,shortage_centavos,overage_centavos,balanced,remittance_number FROM batch_remittances WHERE batch_id=$1', [id])).rows[0] as
        { recorded_by: string; shortage_centavos: number; overage_centavos: number; balanced: boolean; remittance_number: string } | undefined;
      if (!remittance) throw conflict('This route has no remittance to reconcile.');
      if (remittance.recorded_by === actor.id) throw forbidden('A remittance must be reconciled by someone other than the person who counted it.');

      await client.query(
        "UPDATE collection_batches SET status='RECONCILED',reconciled_at=now(),reconciled_by=$2,reconciliation_notes=$3 WHERE id=$1",
        [id, actor.id, input.notes],
      );
      await this.audit(client, actor.id, 'collection.batch.reconcile', id, {
        remittanceNumber: remittance.remittance_number, shortageCentavos: remittance.shortage_centavos,
        overageCentavos: remittance.overage_centavos, balanced: remittance.balanced, notes: input.notes,
      });
      await client.query('COMMIT');
      return this.read(id);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async close(token: string, id: string, raw: unknown): Promise<BatchDetail> {
    parse(CloseBatchInput, raw);
    return this.step(token, id, 'CLOSED', 'collection.reconcile', 'collection.batch.close');
  }

  // ------------------------------------------------------------- collected money

  /**
   * Called from the payment service while it is already inside its posting transaction, so a
   * collection and the payment that carries it commit or fail together. Recording onto a
   * route needs `collection.manage` on top of the payment permission, the account has to be
   * on the frozen sheet, and the route is locked so two collections cannot interleave. An
   * open route is started here, because a payment is what starts it.
   */
  async attach(client: Client, token: string, batchId: string, subscriberId: string): Promise<{ batchId: string; batchNumber: string }> {
    await markCollectionTransaction(client);
    await this.actor(token, 'collection.manage', client);
    const batch = await this.locked(client, batchId);
    const onRoute = (await client.query('SELECT 1 FROM batch_accounts WHERE batch_id=$1 AND subscriber_id=$2', [batchId, subscriberId])).rows[0];
    if (!onRoute) throw invalid('This account is not on the collection route of that batch.', { collectionBatchId: ['Choose an account that is on the printed route sheet.'] });
    if (!isCollectable(batch.status as Batch['status'])) {
      throw conflict(`${batch.batch_number} is ${batch.status.toLowerCase().replace('_', ' ')}, so it no longer accepts collections. Record the payment without a batch.`);
    }
    if (batch.status === 'OPEN') await client.query("UPDATE collection_batches SET status='IN_PROGRESS',started_at=now() WHERE id=$1", [batchId]);
    return { batchId, batchNumber: batch.batch_number };
  }

  // ------------------------------------------------------------- internals

  /**
   * One lifecycle step. The transition is checked here for a clear message and again by the
   * database guard, so neither a direct SQL update nor a race can skip or repeat a step.
   */
  private async step(
    token: string, id: string, to: Batch['status'], permission: Permission, action: string,
    options: { notes?: string; before?: (client: Client, actor: { id: string }) => Promise<void> } = {},
  ): Promise<BatchDetail> {
    const client = await this.auth.pool.connect();
    try {
      await this.begin(client);
      const actor = await this.actor(token, permission, client);
      const batch = await this.locked(client, id);
      const from = batch.status as Batch['status'];
      if (from === to) throw conflict(`This route is already ${label(from).toLowerCase()}.`);
      if (from === 'CLOSED') throw conflict('A closed route cannot be changed.');
      if (!canTransition(from, to)) throw conflict(`A ${label(from).toLowerCase()} route cannot become ${label(to).toLowerCase()}.`);
      await options.before?.(client, actor);
      await client.query(
        `UPDATE collection_batches SET status=$2,started_at=coalesce(started_at,CASE WHEN $2='IN_PROGRESS' THEN now() END),
           submitted_at=CASE WHEN $2='SUBMITTED' THEN now() END,closed_at=CASE WHEN $2='CLOSED' THEN now() END WHERE id=$1`,
        [id, to],
      );
      await this.audit(client, actor.id, action, id, { from, to, ...(options.notes ? { notes: options.notes } : {}) });
      await client.query('COMMIT');
      return this.read(id);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  private async locked(client: Client, id: string) {
    const row = (await client.query(
      'SELECT id,batch_number,status,collector_id,area_id FROM collection_batches WHERE id=$1 FOR UPDATE', [id],
    )).rows[0] as { id: string; batch_number: string; status: string; collector_id: string; area_id: string } | undefined;
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Collection batch not found.');
    return row;
  }

  /** Gap-free like a receipt number, and never reused after a batch is closed. */
  private async nextNumber(client: Client, kind: 'BATCH' | 'REMITTANCE', year: number, format: (year: number, value: number) => string) {
    await lock(client, `document:${kind.toLowerCase()}:${year}`);
    const value = (await client.query(
      `INSERT INTO document_sequences(kind,year,next_value) VALUES($1,$2,1002) ON CONFLICT(kind,year) DO UPDATE SET next_value=document_sequences.next_value+1 RETURNING next_value-1 AS value`,
      [kind, year],
    )).rows[0].value as number;
    return format(year, value);
  }

  private async read(id: string): Promise<BatchDetail> {
    const result = await this.auth.pool.query(
      `WITH page AS (SELECT $1::uuid AS id),${figuresCte},${collectedCte},${progressCte},${remittanceCte}
       SELECT ${detailColumns} ${batchFrom}
       LEFT JOIN figures f ON f.id=b.id LEFT JOIN progress g ON g.batch_id=b.id LEFT JOIN remittance rm ON rm.batch_id=b.id
       WHERE b.id=$1`, [id],
    );
    if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Collection batch not found.');
    return present(result.rows[0] as Row);
  }
}

const labels: Record<Batch['status'], string> = {
  OPEN: 'Open', IN_PROGRESS: 'In progress', SUBMITTED: 'Submitted', REMITTED: 'Remitted', RECONCILED: 'Reconciled', CLOSED: 'Closed',
};
const label = (status: Batch['status']) => labels[status];
