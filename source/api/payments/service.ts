import {
  AccountQuery, PaymentQuery, RecordPaymentInput, ReversePaymentInput, VerifyPaymentInput, VoidPaymentInput,
  formatReceiptNumber,
  type Payment, type PaymentAllocation, type PaymentDetail, type PaymentList, type PaymentResult, type SubscriberAccount,
} from '../../shared/payments';
import { ApiError } from '../auth/errors';
import type { AuthService } from '../auth/service';
import { parse } from '../master-data/service';
import { lock, postLedgerEntry, type Client } from '../billing/ledger';
import { allocatePayment, applyToInvoice, availableCredit, refreshInvoiceStatus, spendCredit, type AllocationTouch } from './allocation';
import { readProof, removeProof, storeProof } from './proofs';

type Permission = 'payment.view' | 'payment.create' | 'payment.verify' | 'payment.reverse';
type Row = Record<string, unknown>;
const conflict = (message: string) => new ApiError(409, 'CONFLICT', message);
const invalid = (message: string, fields?: Record<string, string[]>) => new ApiError(422, 'VALIDATION', message, fields);
const forbidden = (message: string) => new ApiError(403, 'FORBIDDEN', message);
const today = () => new Date().toISOString().slice(0, 10);

const paymentSelect = `SELECT p.id,p.receipt_number AS "receiptNumber",p.method,p.status,p.direction,
  p.amount_centavos AS "amountCentavos",to_char(p.received_on,'YYYY-MM-DD') AS "receivedOn",p.reference_number AS "referenceNumber",p.notes,p.reason,
  p.reversal_of_id AS "reversalOfId",o.receipt_number AS "reversalOfReceipt",p.void_reason AS "voidReason",p.voided_at AS "voidedAt",
  p.subscriber_id AS "subscriberId",s.code AS "subscriberCode",s.name AS "subscriberName",p.recorded_by AS "recordedBy",
  coalesce((SELECT sum(a.amount_centavos) FROM payment_allocations a WHERE a.payment_id=p.id AND a.reversed_at IS NULL),0)::int AS "appliedCentavos",
  u.display_name AS "recordedName",v.display_name AS "verifiedName",p.verified_by AS "verifiedBy",p.verified_at AS "verifiedAt",p.created_at AS "createdAt",
  CASE WHEN pr.id IS NULL THEN NULL ELSE jsonb_build_object('id',pr.id,'originalName',pr.original_name,'storedName',pr.stored_name,
    'mimeType',pr.mime_type,'byteSize',pr.byte_size,'sha256',pr.sha256,'uploadedAt',pr.uploaded_at) END AS proof
  FROM payments p
  JOIN subscribers s ON s.id=p.subscriber_id
  JOIN users u ON u.id=p.recorded_by
  LEFT JOIN users v ON v.id=p.verified_by
  LEFT JOIN payments o ON o.id=p.reversal_of_id
  LEFT JOIN payment_proofs pr ON pr.payment_id=p.id`;

const allocationSelect = `SELECT a.id,a.invoice_id AS "invoiceId",i.invoice_number AS "invoiceNumber",a.amount_centavos AS "amountCentavos",
  a.source,a.reversed_at AS "reversedAt",a.created_at AS "createdAt",a.payment_id AS "sourcePaymentId",i.status AS "invoiceStatus"
  FROM payment_allocations a JOIN invoices i ON i.id=a.invoice_id`;

/**
 * Only money that reached the account counts as applied. A claim awaiting confirmation,
 * a voided entry and a reversed entry hold nothing, and a reversal is reported as fully
 * applied because it is what took the money back.
 */
function present(row: Row): Payment {
  const amountCentavos = row.amountCentavos as number;
  const held = row.status === 'POSTED';
  const reversal = row.direction === 'REVERSAL';
  const appliedCentavos = !held ? 0 : reversal ? amountCentavos : (row.appliedCentavos as number);
  return { ...row, amountCentavos, appliedCentavos, advanceCentavos: held ? Math.max(0, amountCentavos - appliedCentavos) : 0 } as unknown as Payment;
}

export class PaymentService {
  constructor(private auth: AuthService) {}

  private actor(token: string, permission: Permission, client?: Client) {
    return this.auth.authorize(token, permission, client);
  }

  /**
   * Starts a posting transaction. The transaction local `bcis.posting` flag is the only
   * way a session may move a posted payment, so a direct SQL change outside this service
   * is refused by the database guard.
   */
  private async begin(client: Client) {
    await client.query('BEGIN');
    await client.query("SELECT set_config('bcis.posting','on',true)");
  }

  private audit(client: Client, actorId: string, action: string, subjectId: string | null, details: unknown) {
    return client.query('INSERT INTO audit_logs(actor_id,action,subject_id,details) VALUES($1,$2,$3,$4)', [actorId, action, subjectId, JSON.stringify(details)]);
  }

  // ------------------------------------------------------------- reading

  async list(token: string, raw: unknown): Promise<PaymentList> {
    await this.actor(token, 'payment.view');
    const query = parse(PaymentQuery, raw);
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (query.q) {
      values.push(`%${query.q.replace(/[\\%_]/g, '\\$&')}%`);
      conditions.push(`(p.receipt_number ILIKE $${values.length} OR p.reference_number ILIKE $${values.length} OR s.code::text ILIKE $${values.length} OR s.name::text ILIKE $${values.length})`);
    }
    if (query.status) { values.push(query.status); conditions.push(`p.status=$${values.length}`); }
    if (query.method) { values.push(query.method); conditions.push(`p.method=$${values.length}`); }
    if (query.subscriberId) { values.push(query.subscriberId); conditions.push(`p.subscriber_id=$${values.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    // One statement gives the count and the page a consistent snapshot, even when the
    // requested page is empty.
    const result = await this.auth.pool.query(
      `WITH filtered AS (SELECT p.id FROM payments p JOIN subscribers s ON s.id=p.subscriber_id ${where}),
         page AS (SELECT id FROM filtered ORDER BY (SELECT received_on FROM payments WHERE id=filtered.id) DESC,id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2})
       SELECT coalesce((SELECT jsonb_agg(to_jsonb(document)) FROM (${paymentSelect} WHERE p.id IN (SELECT id FROM page) ORDER BY p.received_on DESC,p.id DESC) document),'[]') AS items,
         (SELECT count(*)::int FROM filtered) AS total`,
      values.concat([query.perPage, (query.page - 1) * query.perPage]),
    );
    return { items: (result.rows[0].items as Row[]).map(present), total: result.rows[0].total, page: query.page, perPage: query.perPage };
  }

  async get(token: string, id: string): Promise<PaymentDetail> {
    await this.actor(token, 'payment.view');
    const result = await this.auth.pool.query(`${paymentSelect} WHERE p.id=$1`, [id]);
    if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Payment not found.');
    const allocations = (await this.auth.pool.query(`${allocationSelect} WHERE a.payment_id=$1 ORDER BY i.due_date,a.created_at`, [id])).rows as unknown as PaymentAllocation[];
    return { ...present(result.rows[0]), allocations } as PaymentDetail;
  }

  /** The collection view of one subscriber: what is owed, oldest first, and any credit. */
  async account(token: string, raw: unknown): Promise<SubscriberAccount> {
    await this.actor(token, 'payment.view');
    const query = parse(AccountQuery, raw);
    const subscriber = (await this.auth.pool.query('SELECT id,code,name FROM subscribers WHERE id=$1', [query.subscriberId])).rows[0] as { id: string; code: string; name: string } | undefined;
    if (!subscriber) throw new ApiError(404, 'NOT_FOUND', 'Subscriber not found.');
    const items = (await this.auth.pool.query(
      `SELECT id AS "invoiceId",invoice_number AS "invoiceNumber",period_label AS "periodLabel",to_char(due_date,'YYYY-MM-DD') AS "dueDate",
         total_centavos AS "totalCentavos",paid_centavos AS "paidCentavos",balance_centavos AS "balanceCentavos",status
       FROM invoices WHERE subscriber_id=$1 AND status NOT IN ('DRAFT','VOID') ORDER BY due_date,issue_date,id`,
      [subscriber.id],
    )).rows as SubscriberAccount['items'];
    return {
      subscriberId: subscriber.id, subscriberCode: subscriber.code, subscriberName: subscriber.name,
      outstandingCentavos: items.reduce((total, item) => total + item.balanceCentavos, 0),
      advanceCentavos: await availableCredit(this.auth.pool, subscriber.id), items,
    };
  }

  // ------------------------------------------------------------- recording

  /**
   * AT-01 to AT-04: money is applied to the open invoices oldest due date first and
   * whatever is left stays as an advance credit. A cash payment posts at once, while a
   * GCash payment waits for a second person to confirm the reference, so an unverified
   * claim can never reduce a balance.
   */
  async record(token: string, raw: unknown): Promise<PaymentResult> {
    const input = parse(RecordPaymentInput, raw);
    const client = await this.auth.pool.connect();
    let stored: string | null = null;
    try {
      await this.begin(client);
      const actor = await this.actor(token, 'payment.create', client);
      if (input.receivedOn > today()) throw invalid('A payment cannot be received in the future.', { receivedOn: ['Choose today or an earlier date.'] });
      const subscriber = (await client.query('SELECT id,status FROM subscribers WHERE id=$1', [input.subscriberId])).rows[0] as { id: string; status: string } | undefined;
      if (!subscriber) throw new ApiError(404, 'NOT_FOUND', 'Subscriber not found.');
      if (subscriber.status === 'ARCHIVED') throw conflict('An archived subscriber cannot receive a payment.');

      // The file is written before the row that points at it, and removed again when the
      // transaction cannot finish, so a rejected payment leaves nothing behind.
      const file = input.proof ? await storeProof(input.proof) : null;
      if (file) stored = file.storedName;

      const pending = input.method === 'GCASH';
      // A cash payment is posted by the same command, so it takes its receipt before the
      // row is stored and is never observable without one. A GCash payment waits, and a
      // payment with no receipt yet is exactly what the state machine allows.
      const receiptNumber = pending ? null : await this.receiptNumber(client, Number(input.receivedOn.slice(0, 4)));
      const paymentId = (await client.query(
        `INSERT INTO payments(subscriber_id,method,direction,status,amount_centavos,received_on,reference_number,notes,recorded_by,receipt_number)
         VALUES($1,$2,'PAYMENT',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [input.subscriberId, input.method, pending ? 'PENDING' : 'POSTED', input.amountCentavos, input.receivedOn, input.referenceNumber ?? null, input.notes, actor.id, receiptNumber],
      )).rows[0].id as string;
      if (file) {
        await client.query(
          'INSERT INTO payment_proofs(payment_id,original_name,stored_name,mime_type,byte_size,sha256,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [paymentId, file.originalName, file.storedName, file.mimeType, file.byteSize, file.sha256, actor.id],
        );
      }

      let allocatedCentavos = 0;
      let advanceCentavos = 0;
      let touched: AllocationTouch[] = [];
      if (pending) {
        await this.audit(client, actor.id, 'payment.record', paymentId, { method: input.method, amountCentavos: input.amountCentavos, reference: input.referenceNumber, awaitingVerification: true });
      } else {
        const posted = await this.post(client, { paymentId, subscriberId: input.subscriberId, amountCentavos: input.amountCentavos, method: input.method, receivedOn: input.receivedOn, actorId: actor.id, receiptNumber: receiptNumber as string });
        allocatedCentavos = posted.allocation.appliedCentavos;
        advanceCentavos = posted.allocation.advanceCentavos;
        touched = posted.allocation.touched;
        await this.audit(client, actor.id, 'payment.record', paymentId, {
          method: input.method, amountCentavos: input.amountCentavos, receipt: receiptNumber,
          allocatedCentavos, advanceCentavos, settledCentavos: posted.settledCentavos,
        });
      }
      await client.query('COMMIT');
      stored = null;
      return { payment: await this.read(client, paymentId), allocatedCentavos, advanceCentavos, touched };
    } catch (error) {
      await client.query('ROLLBACK');
      if (stored) await removeProof(stored);
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'payments_gcash_reference_idx') {
        throw conflict('That GCash reference has already been recorded. Find the existing receipt instead of entering it twice.');
      }
      throw error;
    } finally { client.release(); }
  }

  /**
   * AT-05: the collector cannot confirm their own entry. A GCash payment becomes a posted
   * payment only once a second person with `payment.verify` has checked the reference
   * against the attached receipt.
   */
  async verify(token: string, id: string, raw: unknown): Promise<PaymentResult> {
    const input = parse(VerifyPaymentInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await this.begin(client);
      const actor = await this.actor(token, 'payment.verify', client);
      const payment = await this.locked(client, id);
      if (payment.direction === 'REVERSAL') throw conflict('A reversal has nothing left to confirm.');
      if (payment.status !== 'PENDING') throw conflict('Only a payment awaiting confirmation can be confirmed.');
      if (payment.recorded_by === actor.id) throw forbidden('A payment must be confirmed by someone other than the person who recorded it.');
      const proof = await client.query('SELECT id FROM payment_proofs WHERE payment_id=$1', [id]);
      if (!proof.rows[0]) throw conflict('Attach the GCash receipt before confirming this payment.');
      const receiptNumber = await this.receiptNumber(client, Number(payment.received_on.slice(0, 4)));

      const posted = await this.post(client, {
        paymentId: id, subscriberId: payment.subscriber_id, amountCentavos: payment.amount_centavos,
        method: payment.method, receivedOn: payment.received_on, actorId: actor.id, receiptNumber,
      });
      await client.query("UPDATE payments SET receipt_number=$2,status='POSTED',verified_by=$3,verified_at=now(),reason=$4 WHERE id=$1", [id, receiptNumber, actor.id, input.notes]);
      await this.audit(client, actor.id, 'payment.verify', id, {
        receipt: receiptNumber, reference: payment.reference_number, allocatedCentavos: posted.allocation.appliedCentavos,
        advanceCentavos: posted.allocation.advanceCentavos, settledCentavos: posted.settledCentavos,
      });
      await client.query('COMMIT');
      return { payment: await this.read(client, id), allocatedCentavos: posted.allocation.appliedCentavos, advanceCentavos: posted.allocation.advanceCentavos, touched: posted.allocation.touched };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  /** Discards an entry that was never posted. A posted payment can only be reversed. */
  async voidPayment(token: string, id: string, raw: unknown) {
    const input = parse(VoidPaymentInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await this.begin(client);
      const actor = await this.actor(token, 'payment.create', client);
      const payment = await this.locked(client, id);
      if (payment.status === 'VOID') throw conflict('This payment is already voided.');
      if (payment.status !== 'PENDING') throw conflict('A posted payment cannot be voided. Reverse it so the receipt history stays complete.');
      await client.query("UPDATE payments SET status='VOID',voided_at=now(),void_reason=$2 WHERE id=$1", [id, input.reason]);
      await this.audit(client, actor.id, 'payment.void', id, { reason: input.reason, reference: payment.reference_number });
      await client.query('COMMIT');
      return await this.read(client, id);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  /**
   * AT-06: a posted payment is never edited or deleted. The reversal takes the money back
   * with its own receipt and ledger line, reopens every invoice the payment had settled
   * and keeps the original entry and its allocations as the audited history.
   */
  async reverse(token: string, id: string, raw: unknown): Promise<PaymentResult> {
    const input = parse(ReversePaymentInput, raw);
    const client = await this.auth.pool.connect();
    try {
      await this.begin(client);
      const actor = await this.actor(token, 'payment.reverse', client);
      const payment = await this.locked(client, id);
      if (payment.direction === 'REVERSAL') throw conflict('This entry is already a reversal.');
      if (payment.status !== 'POSTED') throw conflict('Only a posted payment can be reversed. Void an entry that was never confirmed.');

      const allocations = (await client.query(
        `${allocationSelect} WHERE a.payment_id=$1 AND a.reversed_at IS NULL ORDER BY i.due_date`, [id],
      )).rows as unknown as (PaymentAllocation & { invoiceStatus: string })[];
      if (allocations.some(allocation => allocation.invoiceStatus === 'VOID')) {
        throw conflict('An invoice settled by this payment was voided. Settle the difference with an adjustment instead of reversing it.');
      }

      // The receipt of a reversal comes from the same gap-free sequence, so the reversal
      // is a document of its own and the original receipt keeps its number for ever.
      const receiptNumber = await this.receiptNumber(client, Number(today().slice(0, 4)));
      const reversalId = (await client.query(
        `INSERT INTO payments(subscriber_id,method,direction,status,amount_centavos,received_on,reference_number,notes,reason,reversal_of_id,recorded_by,verified_by,verified_at,receipt_number)
         VALUES($1,$2,'REVERSAL','POSTED',$3,$4,NULL,'',$5,$6,$7,$7,now(),$8) RETURNING id`,
        [payment.subscriber_id, payment.method, payment.amount_centavos, today(), input.reason, id, actor.id, receiptNumber],
      )).rows[0].id as string;

      const originalEntry = (await client.query(
        "SELECT id FROM ledger_entries WHERE reference_type='PAYMENT' AND reference_id=$1 ORDER BY entry_no LIMIT 1", [id],
      )).rows[0]?.id as string | undefined;
      await postLedgerEntry(client, {
        subscriberId: payment.subscriber_id, entryDate: today(), referenceType: 'PAYMENT', referenceId: reversalId, referenceNumber: receiptNumber,
        description: `Reversal of ${payment.receipt_number}: ${input.reason}`.slice(0, 200),
        debitCentavos: payment.amount_centavos, creditCentavos: 0, actorId: actor.id, reversalOfId: originalEntry ?? null,
      });

      const reopened: AllocationTouch[] = [];
      for (const allocation of allocations) {
        await client.query('UPDATE payment_allocations SET reversed_at=now() WHERE id=$1', [allocation.id]);
        await applyToInvoice(client, allocation.invoiceId, -allocation.amountCentavos);
        const refreshed = await refreshInvoiceStatus(client, allocation.invoiceId, today());
        if (refreshed) reopened.push({ ...refreshed, appliedCentavos: allocation.amountCentavos });
      }
      await client.query("UPDATE payments SET status='REVERSED',voided_at=now(),void_reason=$2 WHERE id=$1", [id, input.reason]);
      await this.audit(client, actor.id, 'payment.reverse', id, {
        receipt: receiptNumber, reversedReceipt: payment.receipt_number, amountCentavos: payment.amount_centavos, reason: input.reason, reopenedInvoices: reopened.length,
      });
      await client.query('COMMIT');
      return { payment: await this.read(client, reversalId), allocatedCentavos: payment.amount_centavos, advanceCentavos: 0, touched: reopened };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  // ------------------------------------------------------------- proofs

  /** AT-05: the bytes are served only to a signed-in reader, and never as a path. */
  async proof(token: string, id: string) {
    await this.actor(token, 'payment.view');
    const row = (await this.auth.pool.query(
      `SELECT pr.stored_name AS "storedName",pr.original_name AS "originalName",pr.mime_type AS "mimeType",pr.byte_size AS "byteSize"
       FROM payment_proofs pr WHERE pr.payment_id=$1`, [id],
    )).rows[0] as { storedName: string; originalName: string; mimeType: string; byteSize: number } | undefined;
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'This payment has no attachment.');
    const bytes = await readProof(row.storedName);
    return { fileName: row.originalName, mimeType: row.mimeType, byteSize: row.byteSize, base64: bytes.toString('base64') };
  }

  // ------------------------------------------------------------- internals

  private async locked(client: Client, id: string) {
    const row = (await client.query(
      `SELECT id,subscriber_id,method,direction,status,amount_centavos,to_char(received_on,'YYYY-MM-DD') AS received_on,
         reference_number,receipt_number,recorded_by
       FROM payments WHERE id=$1 FOR UPDATE`, [id],
    )).rows[0] as {
      id: string; subscriber_id: string; method: string; direction: string; status: string; amount_centavos: number;
      received_on: string; reference_number: string | null; receipt_number: string | null; recorded_by: string;
    } | undefined;
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Payment not found.');
    return row;
  }

  /** Gap-free like an invoice number, and never reused after a void or a reversal. */
  private async receiptNumber(client: Client, year: number) {
    await lock(client, `document:receipt:${year}`);
    const value = (await client.query(
      `INSERT INTO document_sequences(kind,year,next_value) VALUES('RECEIPT',$1,1002) ON CONFLICT(kind,year) DO UPDATE SET next_value=document_sequences.next_value+1 RETURNING next_value-1 AS value`,
      [year],
    )).rows[0].value as number;
    return formatReceiptNumber(year, value);
  }

  /**
   * Posts one payment: a single credit line for the whole amount against its receipt, the
   * credit the subscriber already holds spent first, and then this money against the open
   * invoices oldest due date first. The statement therefore shows one credit per payment
   * while the allocations record exactly which invoice it settled.
   */
  private async post(client: Client, options: {
    paymentId: string; subscriberId: string; amountCentavos: number; method: string; receivedOn: string; actorId: string; receiptNumber: string;
  }) {
    const asOf = today();
    await postLedgerEntry(client, {
      subscriberId: options.subscriberId, entryDate: options.receivedOn, referenceType: 'PAYMENT', referenceId: options.paymentId,
      referenceNumber: options.receiptNumber, description: `${options.method === 'GCASH' ? 'GCash' : 'Cash'} payment ${options.receiptNumber} received`,
      debitCentavos: 0, creditCentavos: options.amountCentavos, actorId: options.actorId,
    });
    const settledCentavos = await spendCredit(client, options.subscriberId, asOf, options.actorId, options.paymentId);
    const allocation = await allocatePayment(client, { paymentId: options.paymentId, subscriberId: options.subscriberId, amountCentavos: options.amountCentavos, asOf, actorId: options.actorId });
    return { settledCentavos, allocation };
  }

  private async read(client: Client, id: string) {
    const result = await client.query(`${paymentSelect} WHERE p.id=$1`, [id]);
    if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Payment not found.');
    return present(result.rows[0]);
  }
}
