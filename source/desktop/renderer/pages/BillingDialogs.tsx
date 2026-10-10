import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { decimalMoney, parseCentavos, type Invoice, type InvoiceStatus } from '../../../shared/billing';
import type { MasterList, MasterRecord } from '../../../shared/master-data';
import { LineEditor, type LineDraft } from './BillingPage';

export type DialogState = { kind: 'new' } | { kind: 'view'; id: string } | { kind: 'finalize'; id: string } | { kind: 'adjust'; id: string };

const money = (centavos: number) => `PHP ${decimalMoney(centavos)}`;
const statusTone = (status: InvoiceStatus) => status === 'VOID' || status === 'DRAFT' ? 'neutral' : status === 'OVERDUE' ? 'warn' : status === 'PAID' ? 'good' : 'blue';

type Props = { state: DialogState; onClose(): void; onUnauthorized(): void; onSaved(message: string): void };

export function BillingDialogs({ state, onClose, onUnauthorized, onSaved }: Props) {
  if (state.kind === 'new') return <NewInvoiceDialog onClose={onClose} onUnauthorized={onUnauthorized} onSaved={onSaved} />;
  return <InvoiceDialog id={state.id} intent={state.kind} onClose={onClose} onUnauthorized={onUnauthorized} onSaved={onSaved} />;
}

// ------------------------------------------------------------------- new draft

function NewInvoiceDialog({ onClose, onUnauthorized, onSaved }: { onClose(): void; onUnauthorized(): void; onSaved(message: string): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [services, setServices] = useState<MasterList<'services'> | null>(null);
  const [search, setSearch] = useState(''); const [serviceId, setServiceId] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10)); const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ itemType: 'SUBSCRIPTION', description: 'Subscription', quantity: '1', price: '' }]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [fields, setFields] = useState<Record<string, string[]>>({});
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => { void window.bcis.listServices({ q: search, status: 'ACTIVE', page: 1 }).then((result) => {
      if (!current) return;
      if (result.ok) setServices(result.data as MasterList<'services'>);
      else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => { if (current) setError('Service accounts could not be loaded.'); }); }, 200);
    return () => { current = false; clearTimeout(timer); };
  }, [search]);
  async function submit() {
    setBusy(true); setError(''); setFields({});
    const parsed = lines.map((line) => ({ itemType: line.itemType, description: line.description.trim(), quantity: Number(line.quantity), unitPriceCentavos: parseCentavos(line.price) ?? -1 }));
    if (parsed.some((line) => !Number.isInteger(line.quantity) || line.quantity < 1 || line.unitPriceCentavos === null || line.unitPriceCentavos < 1)) {
      setError('Every line needs a description, a quantity of at least 1 and a price of at least PHP 0.01.'); setBusy(false); return;
    }
    if (!serviceId) { setError('Choose the service account this invoice is for.'); setBusy(false); return; }
    if (!dueDate) { setError('Choose a due date.'); setBusy(false); return; }
    try {
      const result = await window.bcis.createBillingInvoice({ serviceAccountId: serviceId, issueDate, dueDate, notes, items: parsed });
      if (result.ok) onSaved(`Draft ${result.data.id.slice(0, 8)} saved with ${money(result.data.totalCentavos)}. Issue it to assign a number.`);
      else { setError(result.error.message); setFields(result.error.fields ?? {}); if (result.error.status === 401) onUnauthorized(); }
    } catch { setError('The draft invoice could not be saved.'); }
    finally { setBusy(false); }
  }
  return <dialog className="account-dialog master-dialog billing-dialog" ref={dialog} aria-labelledby="new-invoice-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><div><p className="eyebrow">MANUAL INVOICE</p><h2 id="new-invoice-title">New draft invoice</h2></div><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={18} /></button></header>
    {error && <div className="form-alert" role="alert">{error}</div>}
    <div className="account-form">
      <label>Service account<input aria-label="Search service account" placeholder="Search by code or address…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label>Invoice for<select aria-label="Service account" value={serviceId} onChange={(event) => setServiceId(event.target.value)} required><option value="">Choose a service account…</option>{services?.items.map((row: MasterRecord<'services'>) => <option key={row.id} value={row.id}>{row.code} · {row.installationAddress}</option>)}</select></label>
      <div className="master-form-grid">
        <label>Issue date<input aria-label="Issue date" type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} required /></label>
        <label>Due date<input aria-label="Due date" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} required />{fields.dueDate && <small className="field-error">{fields.dueDate.join(' ')}</small>}</label>
      </div>
      <label>Notes<input aria-label="Invoice notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={500} /></label>
      <fieldset className="line-fieldset"><legend>Invoice lines</legend>
        <LineEditor lines={lines} onChange={setLines} disabled={busy} />
      </fieldset>
      <p className="muted">Review each line before saving. The invoice receives a number when you issue it.</p>
    </div>
    <footer className="account-form-footer"><button className="refresh-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy} onClick={() => void submit()}>{busy ? 'Saving…' : 'Save draft'}</button></footer>
  </dialog>;
}

// --------------------------------------------------- view / issue / adjust / void

type Intent = 'view' | 'finalize' | 'adjust';

function InvoiceDialog({ id, intent, onClose, onUnauthorized, onSaved }: { id: string; intent: Intent } & Omit<Props, 'state'>) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  // The dialog can be opened for one action and promoted to another, e.g. View → Issue.
  const [mode, setMode] = useState<Intent>(intent);
  const [reason, setReason] = useState(''); const [asOf, setAsOf] = useState('');
  const [adjustmentType, setAdjustmentType] = useState<'DEBIT' | 'CREDIT'>('DEBIT'); const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [fields, setFields] = useState<Record<string, string[]>>({});
  const [confirmVoid, setConfirmVoid] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let current = true;
    void window.bcis.getBillingInvoice(id).then((result) => {
      if (!current) return;
      if (result.ok) setInvoice(result.data); else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => { if (current) setError('The invoice could not be loaded.'); });
    return () => { current = false; };
  }, [id]);
  async function act(action: 'finalize' | 'adjust' | 'void' | 'reissue') {
    setBusy(true); setError(''); setFields({});
    try {
      let result: { ok: true; data: Invoice } | { ok: false; error: { status: number; message: string; fields?: Record<string, string[]> } };
      if (action === 'finalize') result = await window.bcis.finalizeBillingInvoice(id, { reason, ...(asOf ? { asOf } : {}) });
      else if (action === 'adjust') {
        const amountCentavos = parseCentavos(amount);
        result = amountCentavos === null || amountCentavos < 1
          ? { ok: false, error: { status: 422, message: 'Enter the adjustment amount in pesos, for example 150.00.' } }
          : await window.bcis.adjustBillingInvoice(id, { adjustmentType, amountCentavos, reason });
      } else if (action === 'void') result = await window.bcis.voidBillingInvoice(id, { reason });
      else {
        const draft = invoice;
        result = !draft ? { ok: false, error: { status: 422, message: 'The invoice could not be loaded.' } }
          : await window.bcis.replaceBillingInvoiceItems(id, { reason, items: draft.items.map((item) => ({ itemType: item.itemType, description: item.description, quantity: item.quantity, unitPriceCentavos: item.unitPriceCentavos })) });
      }
      if (result.ok) onSaved(action === 'finalize' ? `Invoice ${result.data.invoiceNumber} issued for ${money(result.data.totalCentavos)}.` : action === 'adjust' ? `Adjustment recorded. Balance is now ${money(result.data.balanceCentavos)}.` : action === 'void' ? `Invoice voided and the reversal posted.` : 'Draft lines replaced.');
      else { setError(result.error.message); setFields(result.error.fields ?? {}); if (result.error.status === 401) onUnauthorized(); }
    } catch { setError('The invoice could not be updated. Try again.'); }
    finally { setBusy(false); }
  }
  return <dialog className="account-dialog master-dialog billing-dialog" ref={dialog} aria-labelledby="invoice-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><div><p className="eyebrow">INVOICE</p><h2 id="invoice-title">{invoice?.invoiceNumber ?? 'Loading…'}</h2></div><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={18} /></button></header>
    {error && <div className="form-alert" role="alert">{error}</div>}
    {!invoice && !error && <p role="status">Loading the invoice…</p>}
    {invoice && <>
      <div className="invoice-summary">
        <div><span>Subscriber</span><strong>{invoice.subscriberCode} · {invoice.subscriberName}</strong></div>
        <div><span>Service</span><strong>{invoice.serviceCode}</strong><small>{invoice.serviceAddress}</small></div>
        <div><span>Period</span><strong>{invoice.periodLabel}</strong><small>{invoice.source === 'MANUAL' ? 'Manual' : `Cycle ${invoice.cycleCode ?? ''}`}</small></div>
        <div><span>Issue / due</span><strong>{invoice.issueDate}</strong><small>due {invoice.dueDate}</small></div>
        <div><span>Status</span><span className={`badge ${statusTone(invoice.status)}`}>{invoice.status}</span></div>
        <div><span>Total</span><strong className="money-cell">{money(invoice.totalCentavos)}</strong><small>balance {money(invoice.balanceCentavos)}</small></div>
      </div>
      <div className="table-scroll"><table className="invoice-lines"><thead><tr><th>#</th><th>Type</th><th>Description</th><th>Plan</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead>
        <tbody>{invoice.items.map((item) => <tr key={item.id}><td>{item.lineNo}</td><td>{item.itemType}</td><td>{item.description}</td><td>{item.planCode ? `${item.planCode} v${item.planVersion ?? 1}` : '—'}</td><td>{item.quantity}</td><td className="money-cell">{money(item.unitPriceCentavos)}</td><td className="money-cell">{money(item.amountCentavos)}</td></tr>)}</tbody>
      </table></div>
      <p className="muted">Subtotal {money(invoice.subtotalCentavos)} · adjustments {money(invoice.adjustmentCentavos)} · total {money(invoice.totalCentavos)}.</p>
      {invoice.adjustments.length > 0 && <div className="history-list"><h3>Corrections</h3>{invoice.adjustments.map((adjustment) => <details key={adjustment.id}><summary><strong>{adjustment.adjustmentType}</strong> {money(adjustment.amountCentavos)} · {adjustment.actorName}<p>{adjustment.reason}</p></summary></details>)}</div>}
      {invoice.voidReason && <p className="muted">Voided: {invoice.voidReason}</p>}
      <div className="account-form">
        {(mode === 'finalize' || mode === 'adjust') && <>
          {mode === 'finalize' && <label>Status as of<input aria-label="Status as of" type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} /><small>Blank uses today. Back-dated issue dates keep their date and are inserted into the statement in date order.</small></label>}
          {mode === 'adjust' && <div className="master-form-grid">
            <label>Adjustment<select aria-label="Adjustment type" value={adjustmentType} onChange={(event) => setAdjustmentType(event.target.value as 'DEBIT' | 'CREDIT')}><option value="DEBIT">Debit — add a charge</option><option value="CREDIT">Credit — reduce the balance</option></select></label>
            <label>Amount (PHP)<input aria-label="Adjustment amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />{fields.amountCentavos && <small className="field-error">{fields.amountCentavos.join(' ')}</small>}<small>A credit must be less than the outstanding balance of {money(invoice.balanceCentavos)}.</small></label>
          </div>}
          <label>Reason<textarea aria-label="Reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} required minLength={3} />{fields.reason && <small className="field-error">{fields.reason.join(' ')}</small>}</label>
        </>}
        {(mode === 'finalize' || mode === 'adjust') && <footer className="account-form-footer">
          <button className="refresh-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={busy || reason.trim().length < 3} onClick={() => void act(mode)}>{busy ? 'Working…' : mode === 'finalize' ? 'Issue invoice' : 'Record adjustment'}</button>
        </footer>}
        {mode === 'view' && invoice.status === 'DRAFT' && <footer className="account-form-footer">
          <button className="refresh-button" disabled={busy} onClick={onClose}>Close</button>
          <button className="primary-button" disabled={busy} onClick={() => setMode('finalize')}>Issue this draft</button>
        </footer>}
        {mode === 'view' && !['DRAFT', 'VOID'].includes(invoice.status) && <footer className="account-form-footer">
          <button className="refresh-button" disabled={busy} onClick={onClose}>Close</button>
          <button className="refresh-button" disabled={busy} onClick={() => { setMode('adjust'); setAdjustmentType('DEBIT'); }}>Adjust</button>
          <button className="refresh-button danger" disabled={busy} onClick={() => setConfirmVoid(true)}>Void</button>
        </footer>}
      </div>
      {confirmVoid && <div className="void-confirm" role="alertdialog" aria-label="Confirm void">
        <p>Voiding keeps the document and its lines, posts a linked reversal and cannot be undone. Re-running the period issues a replacement with a new number.</p>
        <label>Reason<textarea aria-label="Void reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} required minLength={3} /></label>
        <div><button className="refresh-button" disabled={busy} onClick={() => setConfirmVoid(false)}>Keep invoice</button><button className="primary-button" disabled={busy || reason.trim().length < 3} onClick={() => void act('void')}>{busy ? 'Working…' : 'Void invoice'}</button></div>
      </div>}
    </>}
  </dialog>;
}
