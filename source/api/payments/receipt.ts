import { ApiError } from '../auth/errors';
import type { AuthService } from '../auth/service';
import { assertReceiptBalanced, wordsFor, type ReceiptDocument, type ReceiptLine } from '../../shared/documents';
import type { PaymentMethod, PaymentStatus } from '../../shared/payments';

/**
 * The official receipt, built from the database.
 *
 * Three rules decide what may be printed, and each one exists because of a way a receipt can
 * mislead somebody who has no other access to the system:
 *
 * 1. **A claim that nobody has confirmed cannot be printed as a receipt.** A GCash entry
 *    awaiting a second person has no receipt number and has settled nothing. Issuing it a
 *    document anyway would undo the AT-05 property the payment service already enforces.
 * 2. **The allocations shown are the ones the entry made, not the ones still in force.** A
 *    receipt is a historical document: the original of a reversed payment still says what it
 *    settled, marked as reversed, because that is what the subscriber was handed on the day.
 *    A reversal prints the original's allocations with the sign reversed, so the document
 *    says which invoices were reopened and by how much.
 * 3. **The arithmetic is checked before the document exists.** `assertReceiptBalanced`
 *    refuses a receipt whose lines, applied figure, held credit and written words do not
 *    agree, so a defect fails as a 500 in a log rather than as paper in a subscriber's hand.
 */

type Row = Record<string, unknown>;
type Permission = 'payment.view' | 'report.export';
/** Whoever asked for the document, as the authorizer returns them. */
type Actor = { id: string; displayName: string };



/** Joins the addresses a subscriber is served from into one printable line. */
function addressesFrom(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map((entry) => String(entry ?? '').trim()).filter((entry) => entry !== '').join(' | ');
}

export class ReceiptService {
  constructor(private auth: AuthService) {}

  private async actor(token: string, permission: Permission) { return this.auth.authorize(token, permission); }

  /**
   * Builds the receipt for one payment.
   *
   * `permission` is chosen by the caller: reading a receipt is part of `payment.view`, but
   * writing one to disk is `report.export`, so a viewer who may read a payment on screen
   * still cannot produce a document from it.
   */
  async document(token: string, paymentId: string, permission: Permission = 'payment.view'): Promise<{ receipt: ReceiptDocument; actor: Actor }> {
    const actor = await this.actor(token, permission);
    const payment = (await this.auth.pool.query(
      `SELECT p.id,p.receipt_number AS "receiptNumber",p.method,p.status,p.direction,
         p.amount_centavos AS "amountCentavos",to_char(p.received_on,'YYYY-MM-DD') AS "receivedOn",
         p.reference_number AS "referenceNumber",p.notes,p.reason,p.void_reason AS "voidReason",
         p.reversal_of_id AS "reversalOfId",original.receipt_number AS "reversalOfReceipt",
         reversed.receipt_number AS "reversedByReceipt",
         p.subscriber_id AS "subscriberId",s.code AS "subscriberCode",s.name AS "subscriberName",s.addresses AS "addresses",
         recorder.display_name AS "recordedName",verifier.display_name AS "verifiedName",
         p.collection_batch_id IS NOT NULL AS "onRoute",cb.batch_number AS "collectionBatchNumber"
       FROM payments p
       JOIN subscribers s ON s.id=p.subscriber_id
       JOIN users recorder ON recorder.id=p.recorded_by
       LEFT JOIN users verifier ON verifier.id=p.verified_by
       LEFT JOIN payments original ON original.id=p.reversal_of_id
       LEFT JOIN payments reversed ON reversed.reversal_of_id=p.id
       LEFT JOIN collection_batches cb ON cb.id=p.collection_batch_id
       WHERE p.id=$1`,
      [paymentId],
    )).rows[0] as Row | undefined;
    if (!payment) throw new ApiError(404, 'NOT_FOUND', 'Payment not found.');

    const status = payment.status as PaymentStatus;
    const method = payment.method as PaymentMethod;
    const direction = payment.direction as 'PAYMENT' | 'REVERSAL';

    // AT-05: a claim awaiting confirmation is inert and unreceipted. It has no number and
    // settled nothing, so the refusal is the correct answer rather than a limitation.
    if (status === 'PENDING') {
      throw new ApiError(409, 'CONFLICT', 'This GCash claim has not been confirmed yet, so no receipt can be issued. A second authorised person has to confirm it first.');
    }

    const claimedCentavos = Number(payment.amountCentavos);
    // A void settled nothing: the money was never taken, so the document says zero and the
    // claimed figure is printed separately rather than being quietly presented as received.
    const sign = direction === 'REVERSAL' ? -1 : 1;
    const amountCentavos = status === 'VOID' ? 0 : sign * claimedCentavos;

    // A reversal owns no allocations of its own: it marks the original's rows reversed. Its
    // document therefore shows those rows, negated, which is what tells the reader exactly
    // which invoices were reopened.
    const allocationOwner = direction === 'REVERSAL' ? String(payment.reversalOfId) : String(payment.id);
    const allocationSign = direction === 'REVERSAL' ? -1 : 1;
    const rows = (await this.auth.pool.query(
      `SELECT i.invoice_number AS "invoiceNumber",i.period_label AS "periodLabel",
         a.amount_centavos AS "amountCentavos",a.source,a.reversed_at AS "reversedAt"
       FROM payment_allocations a JOIN invoices i ON i.id=a.invoice_id
       WHERE a.payment_id=$1 ORDER BY i.due_date,i.issue_date,i.id`,
      [allocationOwner],
    )).rows as Row[];
    // No line cap is applied here on purpose: the renderer knows how many allocation lines one
    // receipt page can actually carry, and inventing a second, looser number here would let a
    // payment through to a 500 that the renderer would have refused with a 422 and a
    // suggestion to print the statement instead.

    const lines: ReceiptLine[] = rows.map((row) => {
      const reversedAt = row.reversedAt === null || row.reversedAt === undefined ? null : new Date(String(row.reversedAt)).toISOString().slice(0, 10);
      return {
        invoiceNumber: row.invoiceNumber === null ? null : String(row.invoiceNumber),
        periodLabel: String(row.periodLabel ?? ''),
        amountCentavos: allocationSign * Number(row.amountCentavos),
        source: row.source === 'ADVANCE' ? 'ADVANCE' : 'PAYMENT',
        note: reversedAt === null ? '' : direction === 'REVERSAL' ? 'Reopened by this reversal' : `Reversed on ${reversedAt}`,
      };
    });
    const appliedCentavos = lines.reduce((total, line) => total + line.amountCentavos, 0);

    const services = (await this.auth.pool.query(
      `SELECT sp.name,sa.installation_address AS "installationAddress"
       FROM service_accounts sa JOIN service_plans sp ON sp.id=sa.plan_id
       WHERE sa.subscriber_id=$1 ORDER BY sp.name LIMIT 6`,
      [payment.subscriberId],
    )).rows as Row[];

    const receipt = assertReceiptBalanced({
      documentTitle: direction === 'REVERSAL' ? 'REVERSAL RECEIPT' : 'OFFICIAL RECEIPT',
      receiptNumber: payment.receiptNumber === null ? null : String(payment.receiptNumber),
      status,
      direction,
      issuedOn: String(payment.receivedOn),
      method,
      referenceNumber: payment.referenceNumber === null ? null : String(payment.referenceNumber),
      subscriberCode: String(payment.subscriberCode),
      subscriberName: String(payment.subscriberName),
      serviceAddresses: [addressesFrom(payment.addresses), ...services.map((row) => String(row.installationAddress))]
        .filter((entry) => entry.trim() !== '')
        .join(' | '),
      servicesSummary: services
        .map((row) => `${String(row.name)}${row.installationAddress ? ` (${String(row.installationAddress)})` : ''}`)
        .join(', '),
      lines,
      claimedCentavos,
      amountCentavos,
      appliedCentavos,
      advanceCentavos: amountCentavos - appliedCentavos,
      amountInWords: wordsFor(amountCentavos),
      receivedByName: String(payment.recordedName),
      verifiedByName: payment.verifiedName === null ? null : String(payment.verifiedName),
      collectionBatchNumber: payment.collectionBatchNumber === null ? null : String(payment.collectionBatchNumber),
      reversalOfReceipt: payment.reversalOfReceipt === null ? null : String(payment.reversalOfReceipt),
      reason: direction === 'REVERSAL'
        ? String(payment.reason ?? '')
        : status === 'VOID' ? String(payment.voidReason ?? '') : String(payment.notes ?? ''),
      generatedAt: new Date().toISOString(),
      generatedBy: actor.displayName,
      footnote: footnoteFor(status, direction, payment.reversedByReceipt),
    } satisfies ReceiptDocument);

    // The audit entry is written by `recordPrint` after the document has actually been
    // rendered, not here. A refusal to print is not a print, and an audit trail that records
    // receipts nobody received is worse than no audit trail at all.
    return { receipt, actor };
  }

  /** Records that a receipt was produced, once the bytes exist. */
  async recordPrint(actor: Actor, paymentId: string, receipt: ReceiptDocument) {
    await this.auth.pool.query('INSERT INTO audit_logs(actor_id,action,subject_id,details) VALUES($1,$2,$3,$4)', [
      actor.id,
      'receipt.print',
      paymentId,
      JSON.stringify({
        receipt: receipt.receiptNumber,
        status: receipt.status,
        direction: receipt.direction,
        amountCentavos: receipt.amountCentavos,
        claimedCentavos: receipt.claimedCentavos,
        lines: receipt.lines.length,
      }),
    ]);
  }
}

/**
 * The sentence printed at the foot of the document.
 *
 * It states what the receipt is *not*, which is the part a reader needs: a receipt for money
 * that has gone back must point at the receipt that took it, and a receipt for a void must
 * say the entry is still on the record.
 */
function footnoteFor(status: PaymentStatus, direction: 'PAYMENT' | 'REVERSAL', reversedByReceipt: unknown): string {
  if (direction === 'REVERSAL') return 'This receipt takes the amount back from the account. The invoices listed above were reopened and the money is owed again. Both this receipt and the original stay on the record.';
  if (status === 'VOID') return 'This entry was voided before it was confirmed. It holds no receipt number, settled nothing and received nothing; the claim above was discarded. The entry remains on the record for audit.';
  if (status === 'REVERSED') return `The amount on this receipt was taken back by ${reversedByReceipt === null || reversedByReceipt === undefined ? 'a later reversal' : `receipt ${String(reversedByReceipt)}`}. This receipt keeps its number and stays on the record; the invoices above were reopened.`;
  return 'A posted receipt is never edited or deleted. If this payment is wrong, it is reversed with a reason and a receipt of its own, and both documents are kept.';
}
