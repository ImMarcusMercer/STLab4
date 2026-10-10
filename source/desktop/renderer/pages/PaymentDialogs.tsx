import { useEffect, useRef, useState } from 'react';
import { FileCheck2, Printer, ShieldAlert, X } from 'lucide-react';
import { decimalMoney } from '../../../shared/billing';
import type { Actor } from '../../../shared/auth';
import type { Payment, PaymentDetail, PaymentProofContent, PaymentResult } from '../../../shared/payments';

export type PaymentDialogState = { kind: 'view' | 'verify' | 'void' | 'reverse'; id: string };

const money = (centavos: number) => `PHP ${decimalMoney(centavos)}`;
const statusTone = (status: string) => status === 'POSTED' ? 'good' : status === 'PENDING' ? 'warn' : 'neutral';

type Props = { state: PaymentDialogState; user: Actor; onClose(): void; onUnauthorized(): void; onSaved(message: string): void };

export function PaymentDialogs({ state, user, onClose, onUnauthorized, onSaved }: Props) {
  const [payment, setPayment] = useState<PaymentDetail | null>(null);
  const [proof, setProof] = useState<PaymentProofContent | null>(null);
  const [notes, setNotes] = useState(''); const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [fields, setFields] = useState<Record<string, string[]>>({});
  const [printed, setPrinted] = useState('');
  const [mode, setMode] = useState<PaymentDialogState['kind']>(state.kind);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);

  useEffect(() => {
    let current = true; setPayment(null); setProof(null); setError(''); setFields({}); setReason('');
    void window.bcis.getPayment(state.id).then((result) => {
      if (!current) return;
      if (result.ok) setPayment(result.data);
      else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => { if (current) setError('The payment could not be loaded.'); });
    return () => { current = false; };
  }, [state.id]);

  useEffect(() => {
    if (mode !== 'verify' || !payment || proof) return;
    void window.bcis.getPaymentProof(payment.id).then((result) => {
      if (result.ok) setProof(result.data);
      else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => setError('The receipt could not be read.'));
  }, [mode, payment?.id, proof]);

  /**
   * Asks the server for the receipt and lets the main process save it.
   *
   * Nothing here decides what the receipt says and no bytes are built in the renderer, so the
   * document that reaches the customer is the same one the API audited.
   */
  async function printReceipt() {
    setBusy(true); setError('');
    try {
      const result = await window.bcis.printReceipt(payment!.id);
      if (!result.ok) { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); return; }
      // Reported here rather than through onSaved, which closes the dialog. Printing is
      // something the cashier does while still looking at the payment, and dismissing the
      // record they were reading to check it would be backwards.
      setPrinted(result.data.saved
        ? `Receipt ${result.data.fileName} saved.`
        : 'Saving was cancelled, so nothing was written.');
    } catch { setError('The receipt could not be produced. Nothing was printed.'); }
    finally { setBusy(false); }
  }

  async function act() {
    setBusy(true); setError(''); setFields({});
    try {
      let outcome: { ok: true; data: PaymentResult | Payment } | { ok: false; error: { status: number; message: string; fields?: Record<string, string[]> } };
      if (mode === 'verify') outcome = await window.bcis.verifyPayment(state.id, { notes: notes.trim() });
      else if (mode === 'reverse') outcome = await window.bcis.reversePayment(state.id, { reason });
      else outcome = await window.bcis.voidPayment(state.id, { reason });
      if (outcome.ok) {
        const result = outcome.data as PaymentResult;
        const body = mode === 'verify'
          ? `Receipt ${result.payment.receiptNumber} issued: ${money(result.allocatedCentavos)} applied to ${result.touched.length} invoice(s)${result.advanceCentavos > 0 ? `, ${money(result.advanceCentavos)} held as advance credit` : ''}.`
          : mode === 'reverse'
            ? `Reversal ${result.payment.receiptNumber} posted. ${result.touched.length} invoice(s) reopened.`
            : 'Payment voided. It never held a receipt and posted nothing.';
        onSaved(body);
      } else { setError(outcome.error.message); setFields(outcome.error.fields ?? {}); if (outcome.error.status === 401) onUnauthorized(); }
    } catch { setError('The payment could not be updated. Nothing was changed.'); }
    finally { setBusy(false); }
  }

  const canVerify = user.permissions.includes('payment.verify');
  const canReverse = user.permissions.includes('payment.reverse');
  const canCreate = user.permissions.includes('payment.create');
  const isOwnPayment = payment ? payment.recordedBy === user.id : false;
  const voidReasonLength = reason.trim().length;

  return <dialog className="account-dialog master-dialog billing-dialog payment-dialog" ref={dialog} aria-labelledby="payment-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><div><p className="eyebrow">PAYMENT</p><h2 id="payment-title">{payment?.receiptNumber ?? (payment ? 'Awaiting confirmation' : 'Loading…')}</h2></div><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={18} /></button></header>
    {error && <div className="form-alert" role="alert">{error}</div>}
    {!payment && !error && <p role="status">Loading the payment…</p>}
    {payment && <>
      <div className="invoice-summary">
        <div><span>Subscriber</span><strong>{payment.subscriberCode} · {payment.subscriberName}</strong></div>
        <div><span>Method</span><strong>{payment.method}</strong><small>{payment.referenceNumber ?? 'no reference'}</small></div>
        <div><span>Received on</span><strong>{payment.receivedOn}</strong><small>by {payment.recordedName}</small></div>
        <div><span>Status</span><span className={`badge ${statusTone(payment.status)}`}>{payment.status}</span></div>
        <div><span>Amount</span><strong className="money-cell">{money(payment.amountCentavos)}</strong><small>applied {money(payment.appliedCentavos)}</small></div>
        <div><span>Advance</span><strong className="money-cell">{money(payment.advanceCentavos)}</strong><small>{payment.verifiedName ? `confirmed by ${payment.verifiedName}` : 'held for the next invoice'}</small></div>
      </div>

      <div className="table-scroll"><table className="invoice-lines"><thead><tr><th>Invoice</th><th>Source</th><th>Applied</th><th>Created</th><th>Reversed</th></tr></thead><tbody>
        {payment.allocations.map((allocation) => <tr key={allocation.id}>
          <td>{allocation.invoiceNumber ?? 'Draft'}</td>
          <td>{allocation.source === 'ADVANCE' ? 'Advance credit' : 'Payment'}</td>
          <td className="money-cell">{money(allocation.amountCentavos)}</td>
          <td>{allocation.createdAt.slice(0, 10)}</td>
          <td>{allocation.reversedAt ? allocation.reversedAt.slice(0, 10) : '—'}</td>
        </tr>)}
      </tbody><tfoot><tr><td colSpan={2}>Total applied</td><td className="money-cell">{money(payment.appliedCentavos)}</td><td colSpan={2}>{payment.notes || '—'}</td></tr></tfoot></table></div>
      {payment.direction === 'REVERSAL' && <p className="muted">Reverses {payment.reversalOfReceipt}. Reason: {payment.reason}</p>}
      {payment.status === 'VOID' && <p className="muted">Voided: {payment.voidReason}</p>}
      {payment.status === 'REVERSED' && <p className="muted">Reversed on {payment.voidedAt?.slice(0, 10)}. Reason: {payment.voidReason}</p>}

      {payment.proof && <div className="proof-preview">
        <h3>Attached receipt</h3>
        <p className="muted">{payment.proof.originalName} · {(payment.proof.byteSize / 1024).toFixed(0)} KB</p>
        {proof
          ? proof.mimeType === 'application/pdf'
            ? <iframe title="Payment receipt" src={`data:${proof.mimeType};base64,${proof.base64}`} />
            : <img alt={`GCash receipt for ${payment.receiptNumber ?? payment.referenceNumber ?? 'payment'}`} src={`data:${proof.mimeType};base64,${proof.base64}`} />
          : <button className="refresh-button" aria-label="Open payment receipt" onClick={() => { void window.bcis.getPaymentProof(payment.id).then((result) => { if (result.ok) setProof(result.data); else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); } }).catch(() => setError('The receipt could not be read.')); }}><FileCheck2 size={15} />Open receipt</button>}
      </div>}

      {/* The official receipt, offered on its own row rather than inside the proof preview: the
          proof is what the customer sent, this is what the office gives back. */}
      <div className="document-actions">
        <button className="refresh-button" disabled={busy} onClick={() => void printReceipt()}>
          <Printer size={15} />Print official receipt
        </button>
        <small className="muted">
          {printed || (payment.direction === 'REVERSAL'
            ? `Reversal receipt for ${payment.reversalOfReceipt}.`
            : payment.status === 'VOID'
              ? 'This payment was voided, so its receipt shows no money applied.'
              : 'Save or print a copy for the customer.')}
        </small>
      </div>

      {mode === 'verify' && <div className="account-form">
        {isOwnPayment && <p className="field-warning"><ShieldAlert size={15} />Another authorized staff member must confirm a payment you recorded. Ask them to check the GCash reference.</p>}
        <label>Confirmation note<input aria-label="Confirmation note" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={500} /><small>Optional. The reference is compared against the attached receipt by the person confirming.</small></label>
        <footer className="account-form-footer"><button className="refresh-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || isOwnPayment || !payment.proof} onClick={() => void act()}>{busy ? 'Confirming…' : 'Confirm and post'}</button></footer>
      </div>}

      {mode === 'void' && <div className="account-form">
        <label>Void reason<textarea aria-label="Void reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} required minLength={3} />{fields.reason && <small className="field-error">{fields.reason.join(' ')}</small>}<small>This payment never posted, so voiding it discards the entry and frees the reference number.</small></label>
        <footer className="account-form-footer"><button className="refresh-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || voidReasonLength < 3} onClick={() => void act()}>{busy ? 'Working…' : 'Void payment'}</button></footer>
      </div>}

      {mode === 'reverse' && <div className="account-form">
        <p className="muted">Reversing posts a new receipt for {money(payment.amountCentavos)}, debits the ledger, reverses every allocation above and reopens the invoices this payment had settled.</p>
        <label>Reversal reason<textarea aria-label="Reversal reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} required minLength={3} />{fields.reason && <small className="field-error">{fields.reason.join(' ')}</small>}</label>
        <footer className="account-form-footer"><button className="refresh-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || voidReasonLength < 3} onClick={() => void act()}>{busy ? 'Working…' : 'Reverse payment'}</button></footer>
      </div>}

      {mode === 'view' && <footer className="account-form-footer">
        <button className="refresh-button" disabled={busy} onClick={onClose}>Close</button>
        {canVerify && payment.status === 'PENDING' && <button className="primary-button" disabled={busy} onClick={() => setMode('verify')}>Confirm payment</button>}
        {canCreate && payment.status === 'PENDING' && <button className="refresh-button danger" disabled={busy} onClick={() => setMode('void')}>Void</button>}
        {canReverse && payment.status === 'POSTED' && <button className="refresh-button danger" disabled={busy} onClick={() => setMode('reverse')}>Reverse</button>}
      </footer>}
    </>}
  </dialog>;
}
