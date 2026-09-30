import { useEffect, useRef, useState } from 'react';
import { Banknote, ChevronLeft, ChevronRight, Eye, Plus, Receipt, RefreshCw, Search, Smartphone } from 'lucide-react';
import type { Actor } from '../../../shared/auth';
import { decimalMoney, parseCentavos } from '../../../shared/billing';
import type { MasterList, MasterRecord } from '../../../shared/master-data';
import {
  paymentMethodValues, paymentStatusValues, proofByteLimit, proofMimeValues, type PaymentList, type PaymentMethod,
  type PaymentStatus, type SubscriberAccount,
} from '../../../shared/payments';
import { PaymentDialogs, type PaymentDialogState } from './PaymentDialogs';

const money = (centavos: number) => `PHP ${decimalMoney(centavos)}`;
const statusTone = (status: PaymentStatus) => status === 'POSTED' ? 'good' : status === 'PENDING' ? 'warn' : 'neutral';
const methodIcon = (method: PaymentMethod) => method === 'GCASH' ? <Smartphone size={14} /> : <Banknote size={14} />;

export function PaymentsPage({ user, onUnauthorized }: { user: Actor; onUnauthorized(): void }) {
  const [tab, setTab] = useState<'collect' | 'history'>('collect');
  const [revision, setRevision] = useState(0);
  const canCreate = user.permissions.includes('payment.create');
  return <div className="master-page payments-page">
    <div className="module-tabs" role="tablist" aria-label="Payments">
      <button role="tab" aria-selected={tab === 'collect'} onClick={() => setTab('collect')}>Collect payment</button>
      <button role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>Payment history</button>
    </div>
    {tab === 'collect' && <CollectTab revision={revision} canCreate={canCreate} onUnauthorized={onUnauthorized} onChanged={() => setRevision((value) => value + 1)} />}
    {tab === 'history' && <HistoryTab revision={revision} user={user} onUnauthorized={onUnauthorized} onChanged={() => setRevision((value) => value + 1)} />}
  </div>;
}

type AccountItem = SubscriberAccount['items'][number];

/**
 * Indicative split of the entered amount across the open invoices, oldest due date
 * first. It is a preview for the operator; the API stores its own allocation and the
 * command result below replaces this preview immediately.
 */
export function previewAllocation(items: AccountItem[], amountCentavos: number) {
  const order = [...items]
    .filter((item) => item.balanceCentavos > 0)
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate) || (left.invoiceNumber ?? '').localeCompare(right.invoiceNumber ?? ''));
  const steps: { item: AccountItem; amountCentavos: number; balanceCentavos: number }[] = [];
  let remaining = amountCentavos;
  for (const item of order) {
    if (remaining <= 0) break;
    const step = Math.min(item.balanceCentavos, remaining);
    steps.push({ item, amountCentavos: step, balanceCentavos: item.balanceCentavos - step });
    remaining -= step;
  }
  return { steps, appliedCentavos: amountCentavos - remaining, advanceCentavos: remaining };
}

// A revision reloads the tab data after a command instead of remounting it, so the
// confirmation the operator just earned, and the account they were collecting from, stay
// on screen.
function CollectTab({ revision, canCreate, onUnauthorized, onChanged }: { revision: number; canCreate: boolean; onUnauthorized(): void; onChanged(): void }) {
  const [search, setSearch] = useState(''); const [subscribers, setSubscribers] = useState<MasterList<'subscribers'> | null>(null);
  const [selected, setSelected] = useState<MasterRecord<'subscribers'> | null>(null);
  const [account, setAccount] = useState<SubscriberAccount | null>(null); const [loading, setLoading] = useState(false);
  const [finding, setFinding] = useState(true);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [amount, setAmount] = useState(''); const [receivedOn, setReceivedOn] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState(''); const [notes, setNotes] = useState('');
  const [proof, setProof] = useState<{ fileName: string; mimeType: (typeof proofMimeValues)[number]; byteSize: number; base64: string } | null>(null);
  const [busy, setBusy] = useState(false); const [fields, setFields] = useState<Record<string, string[]>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  // Clearing the attachment has to clear the file control as well, otherwise the control
  // keeps a file that the screen no longer shows and re-picking that same file would not
  // fire a change event.
  function clearProof() {
    setProof(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  useEffect(() => {
    let current = true; setFinding(true);
    const timer = setTimeout(() => { void window.bcis.listSubscribers({ q: search, page: 1 }).then((result) => {
      if (!current) return;
      if (result.ok) setSubscribers(result.data as MasterList<'subscribers'>);
      else { setSubscribers(null); setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => { if (current) { setSubscribers(null); setError('Subscribers could not be searched.'); } }).finally(() => { if (current) setFinding(false); }); }, 200);
    return () => { current = false; clearTimeout(timer); };
  }, [search]);

  useEffect(() => {
    if (!selected) { setAccount(null); return; }
    let current = true; setLoading(true); setError('');
    void window.bcis.getSubscriberAccount(selected.id).then((result) => {
      if (!current) return;
      if (result.ok) setAccount(result.data);
      else { setAccount(null); setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => { if (current) setError('The account balance could not be loaded.'); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [selected, revision]);

  const amountCentavos = parseCentavos(amount);
  const preview = account && amountCentavos && amountCentavos > 0 ? previewAllocation(account.items, amountCentavos) : null;
  const today = new Date().toISOString().slice(0, 10);

  async function submit() {
    if (!selected) { setError('Choose the subscriber who is paying.'); return; }
    if (amountCentavos === null || amountCentavos < 1) { setError('Enter the amount received in pesos, for example 750.00.'); return; }
    if (method === 'GCASH' && !/^[A-Za-z0-9-]{4,40}$/.test(reference.trim())) { setError('Enter the GCash reference number exactly as it appears on the receipt.'); return; }
    if (method === 'GCASH' && !proof) { setError('Attach the GCash receipt image or PDF before recording the payment.'); return; }
    setBusy(true); setError(''); setFields({}); setNotice('');
    try {
      const result = await window.bcis.recordPayment({
        subscriberId: selected.id, method, amountCentavos, receivedOn, notes: notes.trim(),
        ...(method === 'GCASH' ? { referenceNumber: reference.trim() } : {}),
        ...(method === 'GCASH' && proof ? { proof: { fileName: proof.fileName, mimeType: proof.mimeType, base64: proof.base64 } } : {}),
      });
      if (result.ok) {
        const { payment, allocatedCentavos, advanceCentavos, touched } = result.data;
        setNotice(payment.status === 'PENDING'
          ? `${payment.method} payment of ${money(payment.amountCentavos)} recorded and awaiting confirmation by another user.`
          : `Receipt ${payment.receiptNumber} for ${money(payment.amountCentavos)}: ${money(allocatedCentavos)} applied to ${touched.length} invoice(s)${advanceCentavos > 0 ? `, ${money(advanceCentavos)} held as advance credit` : ''}.`);
        setAmount(''); setReference(''); setNotes(''); clearProof();
        onChanged();
      } else { setError(result.error.message); setFields(result.error.fields ?? {}); if (result.error.status === 401) onUnauthorized(); }
    } catch { setError('The payment could not be recorded. Nothing was saved.'); }
    finally { setBusy(false); }
  }

  return <div>
    <div className="page-heading"><div><p className="eyebrow">COLLECTIONS</p><h1>Collect payment</h1><p className="muted">Open the account, take the money and let the API settle the oldest invoice first. Every receipt number is issued by the server.</p></div></div>
    {error && <div className="form-alert" role="alert">{error}</div>}{notice && <div className="success-notice" role="status">{notice}</div>}
    <div className="master-toolbar">
      <input aria-label="Search subscriber to collect from" placeholder="Subscriber code or name…" value={search} onChange={(event) => setSearch(event.target.value)} />
    </div>
    {search && <section className="users-table-panel subscriber-picker" aria-busy={finding}>
      <header><h2>Subscribers</h2><span className="muted">{finding ? 'Searching…' : 'Choose the paying account'}</span></header>
      <div className="table-scroll"><table><thead><tr><th>Account</th><th>Name</th><th>Contact</th><th><span className="sr-only">Select</span></th></tr></thead><tbody>
        {subscribers?.items.map((row: MasterRecord<'subscribers'>) => <tr key={row.id} className={selected?.id === row.id ? 'row-selected' : ''}><td>{row.code}</td><td>{row.name}</td><td>{row.contact || '—'}</td><td><button className="text-button" aria-label={`Collect from ${row.code}`} onClick={() => { setSelected(row); setNotice(''); setError(''); }}>{selected?.id === row.id ? 'Selected' : 'Select'}</button></td></tr>)}
      </tbody></table>{!finding && !subscribers?.items.length && <p className="table-state">No subscriber matches this search.</p>}</div>
    </section>}

    {selected && <section className="panel payment-account" aria-busy={loading}>
      <header className="panel-top"><div><h2>{selected.code} · {selected.name}</h2><p className="muted">{selected.contact || 'No contact on file'}</p></div><div className="row-actions"><button className="text-button" aria-label="Close subscriber account" onClick={() => { setSelected(null); setNotice(''); }}>Close</button></div></header>
      <div className="account-summary">
        <div><span>Outstanding</span><strong className="money-cell">{account ? money(account.outstandingCentavos) : '—'}</strong><small>{account?.items.length ?? 0} open invoice(s)</small></div>
        <div><span>Advance credit</span><strong className="money-cell">{account ? money(account.advanceCentavos) : '—'}</strong><small>Applied to the next invoice</small></div>
        <div><span>Oldest due</span><strong>{account?.items[0]?.dueDate ?? '—'}</strong><small>{account?.items[0]?.invoiceNumber ?? 'Nothing open'}</small></div>
      </div>
      {account && account.items.length > 0 && <div className="table-scroll"><table><thead><tr><th>Invoice</th><th>Period</th><th>Due</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead><tbody>
        {account.items.map((item) => <tr key={item.invoiceId}><td><strong>{item.invoiceNumber ?? 'Draft'}</strong></td><td>{item.periodLabel}</td><td>{item.dueDate}</td><td className="money-cell">{money(item.totalCentavos)}</td><td className="money-cell">{money(item.paidCentavos)}</td><td className="money-cell">{money(item.balanceCentavos)}</td><td><span className="badge blue">{item.status}</span></td></tr>)}
      </tbody></table></div>}
      {account && !account.items.length && <p className="table-state">This account has no open invoice. Any payment is held as advance credit.</p>}
    </section>}

    {selected && canCreate && <section className="panel billing-command payment-command">
      <div className="billing-command-fields">
        <label>Method<select aria-label="Payment method" value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)}>{paymentMethodValues.map((value) => <option key={value} value={value}>{value === 'CASH' ? 'Cash' : 'GCash'}</option>)}</select></label>
        <label>Amount received (PHP)<input aria-label="Amount received" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" />{fields.amountCentavos && <small className="field-error">{fields.amountCentavos.join(' ')}</small>}</label>
        <label>Received on<input aria-label="Received on" type="date" value={receivedOn} max={today} onChange={(event) => setReceivedOn(event.target.value)} />{fields.receivedOn && <small className="field-error">{fields.receivedOn.join(' ')}</small>}<small>A payment cannot be received in the future.</small></label>
      </div>
      {method === 'GCASH' && <div className="billing-command-fields">
        <label>GCash reference number<input aria-label="GCash reference number" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={40} placeholder="e.g. 9A2B3C4D5E" />{fields.referenceNumber && <small className="field-error">{fields.referenceNumber.join(' ')}</small>}<small>Letters, digits and dashes. A reference already in use is refused.</small></label>
        <label>GCash receipt<input ref={fileRef} aria-label="GCash receipt image" type="file" accept="image/png,image/jpeg,application/pdf" onChange={(event) => void attach(event.target.files?.[0] ?? null)} /><small>PNG, JPEG or PDF up to 5 MB. Stored on the server with a SHA-256 fingerprint.</small></label>
      </div>}
      {proof && <p className="proof-chip"><Receipt size={14} />{proof.fileName} · {(proof.byteSize / 1024).toFixed(0)} KB<button type="button" className="text-button" aria-label="Remove attached receipt" onClick={clearProof}>Remove</button></p>}
      <label className="notes-field">Notes<input aria-label="Payment notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={500} /></label>
      {preview && <div className="allocation-preview">
        <h3>Allocation preview</h3>
        <div className="table-scroll"><table><thead><tr><th>Invoice</th><th>Due</th><th>Applied</th><th>Balance left</th></tr></thead><tbody>
          {preview.steps.map((step) => <tr key={step.item.invoiceId}><td>{step.item.invoiceNumber ?? 'Draft'}</td><td>{step.item.dueDate}</td><td className="money-cell">{money(step.amountCentavos)}</td><td className="money-cell">{money(step.balanceCentavos)}</td></tr>)}
        </tbody><tfoot><tr><td colSpan={2}>Applied to invoices</td><td className="money-cell">{money(preview.appliedCentavos)}</td><td className="money-cell">{preview.advanceCentavos > 0 ? `${money(preview.advanceCentavos)} advance` : '—'}</td></tr></tfoot></table></div>
        <p className="muted">This preview follows the same oldest-due-first rule the API uses. The stored allocation comes from the server response.</p>
      </div>}
      <div className="billing-command-actions">
        <button className="primary-button" aria-label="Record payment" disabled={busy || !amountCentavos || amountCentavos < 1} onClick={() => void submit()}>{busy ? 'Recording…' : 'Record payment'}</button>
      </div>
    </section>}

    {selected && !canCreate && <p className="info-note"><Search size={19} />Your role can review this account but cannot record a payment. Collection is granted separately from payment review.</p>}
    {!selected && <p className="info-note"><Plus size={19} />Search for a subscriber to open the balance, review what is due and record the payment. A cash payment posts immediately; a GCash payment waits for a second person to confirm the reference.</p>}
  </div>;

  async function attach(file: File | null) {
    if (!file) { clearProof(); return; }
    if (file.size > proofByteLimit) { setError('The receipt is larger than 5 MB. Attach a smaller image or PDF.'); return; }
    const mimeType = file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'application/pdf' ? file.type : null;
    if (!mimeType) { setError('Only a PNG, JPEG or PDF receipt can be attached.'); return; }
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('The file could not be read.'));
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.readAsDataURL(file);
    }).catch(() => '');
    if (!base64) { setError('The receipt could not be read from disk.'); return; }
    setError(''); setProof({ fileName: file.name, mimeType, byteSize: file.size, base64 });
  }
}

function HistoryTab({ revision, user, onUnauthorized, onChanged }: { revision: number; user: Actor; onUnauthorized(): void; onChanged(): void }) {
  const [query, setQuery] = useState(''); const [status, setStatus] = useState(''); const [method, setMethod] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PaymentList | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<PaymentDialogState | null>(null);
  const canVerify = user.permissions.includes('payment.verify');
  const canReverse = user.permissions.includes('payment.reverse');
  const canCreate = user.permissions.includes('payment.create');
  useEffect(() => {
    let current = true; setLoading(true); setError('');
    const timer = setTimeout(() => { void window.bcis.listPayments({
      q: query, page,
      ...(status ? { status: status as PaymentStatus } : {}),
      ...(method ? { method: method as PaymentMethod } : {}),
    }).then((result) => {
      if (!current) return;
      if (result.ok) setData(result.data);
      else { setData(null); setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => { if (current) { setData(null); setError('Payments could not be loaded.'); } }).finally(() => { if (current) setLoading(false); }); }, 180);
    return () => { current = false; clearTimeout(timer); };
  }, [query, status, method, page, revision]);
  return <div>
    <div className="page-heading"><div><p className="eyebrow">COLLECTIONS</p><h1>Payment history</h1><p className="muted">Every receipt, in reverse date order. A posted payment is never edited: it is voided before it posts or reversed after it posts.</p></div></div>
    {error && <div className="form-alert" role="alert">{error}</div>}{notice && <div className="success-notice" role="status">{notice}</div>}
    <div className="master-toolbar">
      <input aria-label="Search payments" placeholder="Receipt, reference, subscriber…" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
      <select aria-label="Filter payment status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option>{paymentStatusValues.map((value) => <option key={value}>{value}</option>)}</select>
      <select aria-label="Filter payment method" value={method} onChange={(event) => { setMethod(event.target.value); setPage(1); }}><option value="">All methods</option>{paymentMethodValues.map((value) => <option key={value}>{value}</option>)}</select>
      <button className="refresh-button" disabled={loading} onClick={() => setPage(1)}><RefreshCw size={14} />Refresh</button>
    </div>
    <section className="users-table-panel" aria-busy={loading}>
      <header><h2>{data?.total ?? 0} payments</h2><span className="muted">Page {page} of {Math.max(1, Math.ceil((data?.total ?? 0) / 20))}</span></header>
      {loading ? <p className="table-state" role="status">Loading payments…</p> : <div className="table-scroll"><table><thead><tr><th>Receipt</th><th>Subscriber</th><th>Method</th><th>Received</th><th>Amount</th><th>Applied</th><th>Advance</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        {data?.items.map((payment) => <tr key={payment.id}>
          <td><strong>{payment.receiptNumber ?? 'Not issued'}</strong><small className="current-user">{payment.reversalOfReceipt ? `reverses ${payment.reversalOfReceipt}` : payment.referenceNumber ?? payment.direction}</small></td>
          <td>{payment.subscriberCode}<small className="current-user">{payment.subscriberName}</small></td>
          <td><span className="badge">{methodIcon(payment.method)} {payment.method}</span></td>
          <td>{payment.receivedOn}<small className="current-user">{payment.recordedName}</small></td>
          <td className="money-cell">{money(payment.amountCentavos)}</td>
          <td className="money-cell">{money(payment.appliedCentavos)}</td>
          <td className="money-cell">{payment.advanceCentavos ? money(payment.advanceCentavos) : '—'}</td>
          <td><span className={`badge ${statusTone(payment.status)}`}>{payment.status}</span></td>
          <td><div className="row-actions">
            <button className="text-button" aria-label={`View ${payment.receiptNumber ?? payment.id.slice(0, 8)}`} onClick={() => setDialog({ kind: 'view', id: payment.id })}>View</button>
            {canVerify && payment.status === 'PENDING' && <button className="text-button" aria-label={`Confirm ${payment.referenceNumber ?? 'payment'}`} onClick={() => setDialog({ kind: 'verify', id: payment.id })}>Confirm</button>}
            {canCreate && payment.status === 'PENDING' && <button className="text-button" aria-label={`Void ${payment.referenceNumber ?? 'payment'}`} onClick={() => setDialog({ kind: 'void', id: payment.id })}>Void</button>}
            {canReverse && payment.status === 'POSTED' && <button className="text-button" aria-label={`Reverse ${payment.receiptNumber}`} onClick={() => setDialog({ kind: 'reverse', id: payment.id })}>Reverse</button>}
          </div></td>
        </tr>)}
      </tbody></table>{data?.items.length === 0 && <p className="table-state">No payments match this search.</p>}</div>}
      <footer><span>Receipt numbers are gap-free per year. Reversals keep the original receipt visible.</span><div><button className="icon-button" aria-label="Previous page" disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={16} /></button><button className="icon-button" aria-label="Next page" disabled={loading || page * 20 >= (data?.total ?? 0)} onClick={() => setPage((value) => value + 1)}><ChevronRight size={16} /></button></div></footer>
    </section>
    <p className="info-note"><Eye size={19} />A payment awaiting confirmation cannot be posted by the person who recorded it. Void discards an entry that never posted; reverse takes posted money back with its own receipt, ledger debit and reopened invoices.</p>
    {dialog && <PaymentDialogs state={dialog} user={user} onClose={() => setDialog(null)} onUnauthorized={onUnauthorized} onSaved={(message) => { setDialog(null); setNotice(message); onChanged(); setPage(1); }} />}
  </div>;
}
