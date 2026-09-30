import { deriveStatus } from '../../shared/billing';
import { planAllocation, type OpenInvoice } from '../../shared/payments';
import { lock, type Client } from '../billing/ledger';

export type AllocationTouch = { invoiceId: string; invoiceNumber: string | null; appliedCentavos: number; balanceCentavos: number; status: string };

/**
 * The invoices a payment may settle, oldest due date first. A draft is not a debt yet and
 * a void invoice keeps no balance, so neither can ever take money.
 */
export async function openInvoices(client: Client, subscriberId: string): Promise<OpenInvoice[]> {
  const rows = (await client.query(
    `SELECT id,to_char(due_date,'YYYY-MM-DD') AS "dueDate",to_char(issue_date,'YYYY-MM-DD') AS "issueDate",balance_centavos AS "balanceCentavos"
     FROM invoices WHERE subscriber_id=$1 AND status NOT IN ('DRAFT','VOID') AND balance_centavos>0
     ORDER BY due_date,issue_date,id`,
    [subscriberId],
  )).rows as OpenInvoice[];
  return rows;
}

/**
 * Recomputes the status from the figures the invoice now carries. An invoice whose
 * balance reaches zero while an advance allocation is standing was settled by credit, so
 * the statement shows CREDITED rather than a cash payment.
 */
export async function refreshInvoiceStatus(client: Client, invoiceId: string, asOf: string) {
  const row = (await client.query(
    `SELECT i.invoice_number AS "invoiceNumber",i.total_centavos AS "totalCentavos",i.paid_centavos AS "paidCentavos",to_char(i.due_date,'YYYY-MM-DD') AS "dueDate",
       EXISTS (SELECT 1 FROM payment_allocations a WHERE a.invoice_id=i.id AND a.source='ADVANCE' AND a.reversed_at IS NULL) AS "byCredit"
     FROM invoices i WHERE i.id=$1 FOR UPDATE`,
    [invoiceId],
  )).rows[0] as { invoiceNumber: string | null; totalCentavos: number; paidCentavos: number; dueDate: string; byCredit: boolean } | undefined;
  if (!row) return null;
  const status = deriveStatus({ totalCentavos: row.totalCentavos, paidCentavos: row.paidCentavos, dueDate: row.dueDate, asOf, settledByCredit: row.byCredit });
  await client.query('UPDATE invoices SET status=$2 WHERE id=$1', [invoiceId, status]);
  return { invoiceId, invoiceNumber: row.invoiceNumber, appliedCentavos: 0, balanceCentavos: row.totalCentavos - row.paidCentavos, status } satisfies AllocationTouch;
}

/** Moves the paid and balance figures of an invoice by a signed amount. */
export async function applyToInvoice(client: Client, invoiceId: string, amountCentavos: number) {
  await client.query('UPDATE invoices SET paid_centavos=paid_centavos+$2,balance_centavos=balance_centavos-$2 WHERE id=$1', [invoiceId, amountCentavos]);
}

/**
 * Money received that is not tied to an invoice yet. Taken from the posted payments of
 * the subscriber, oldest first, so the credit that is spent is the credit that was
 * received first. The payment currently being posted is left out, because its own money is
 * allocated by this command and must never be spent twice.
 */
export async function heldCredit(client: Client, subscriberId: string, excludePaymentId?: string | null) {
  const rows = (await client.query(
    `SELECT p.id,p.amount_centavos AS "amountCentavos",p.received_on AS "receivedOn",to_char(p.received_on,'YYYY-MM-DD') AS "receivedDate",
       coalesce((SELECT sum(a.amount_centavos) FROM payment_allocations a WHERE a.payment_id=p.id AND a.reversed_at IS NULL),0)::int AS "appliedCentavos"
     FROM payments p WHERE p.subscriber_id=$1 AND p.status='POSTED' AND p.direction='PAYMENT' AND ($2::uuid IS NULL OR p.id<>$2)
     ORDER BY p.received_on,p.id`,
    [subscriberId, excludePaymentId ?? null],
  )).rows as { id: string; amountCentavos: number; receivedOn: string; receivedDate: string; appliedCentavos: number }[];
  return rows;
}

export async function availableCredit(client: Client, subscriberId: string) {
  const rows = await heldCredit(client, subscriberId);
  return rows.reduce((total, row) => total + row.amountCentavos - row.appliedCentavos, 0);
}

/**
 * Spends the credit a subscriber already holds against their open invoices, oldest due
 * date first, and returns the total that was settled. Each allocation keeps a reference to
 * the payment whose money it spent, so the credit is never anonymous.
 */
export async function spendCredit(client: Client, subscriberId: string, asOf: string, actorId: string, excludePaymentId?: string | null) {
  await lock(client, `allocation:${subscriberId}`);
  const pool = (await heldCredit(client, subscriberId, excludePaymentId)).filter(row => row.amountCentavos > row.appliedCentavos);
  if (!pool.length) return 0;
  let settled = 0;
  for (const source of pool) {
    const usable = source.amountCentavos - source.appliedCentavos;
    if (usable <= 0) continue;
    const plan = planAllocation(await openInvoices(client, subscriberId), usable);
    for (const step of plan.allocations) {
      await client.query(
        `INSERT INTO payment_allocations(payment_id,invoice_id,source,amount_centavos,actor_id) VALUES($1,$2,'ADVANCE',$3,$4)`,
        [source.id, step.invoiceId, step.amountCentavos, actorId],
      );
      await applyToInvoice(client, step.invoiceId, step.amountCentavos);
      await refreshInvoiceStatus(client, step.invoiceId, asOf);
      settled += step.amountCentavos;
    }
    if (settled >= usable) break;
  }
  return settled;
}

/** Applies one amount to the open invoices of a subscriber and records every step. */
export async function allocatePayment(client: Client, options: {
  paymentId: string; subscriberId: string; amountCentavos: number; asOf: string; actorId: string;
}) {
  await lock(client, `allocation:${options.subscriberId}`);
  const plan = planAllocation(await openInvoices(client, options.subscriberId), options.amountCentavos);
  const touched: AllocationTouch[] = [];
  for (const step of plan.allocations) {
    await client.query(
      `INSERT INTO payment_allocations(payment_id,invoice_id,source,amount_centavos,actor_id) VALUES($1,$2,'PAYMENT',$3,$4)`,
      [options.paymentId, step.invoiceId, step.amountCentavos, options.actorId],
    );
    await applyToInvoice(client, step.invoiceId, step.amountCentavos);
    const refreshed = await refreshInvoiceStatus(client, step.invoiceId, options.asOf);
    touched.push({
      invoiceId: step.invoiceId, invoiceNumber: refreshed?.invoiceNumber ?? null, appliedCentavos: step.amountCentavos,
      balanceCentavos: refreshed?.balanceCentavos ?? 0, status: refreshed?.status ?? 'UNPAID',
    });
  }
  return { ...plan, touched };
}
