import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Banknote, CheckCircle2, ClipboardCheck, Printer, RefreshCw, Smartphone, Wallet } from 'lucide-react';
import type { Actor } from '../../../shared/auth';
import { decimalMoney, parseCentavos } from '../../../shared/billing';
import { paymentMethodValues, type PaymentMethod } from '../../../shared/payments';
import { batchStatusValues, type BatchAccountStatus, type BatchDetail, type BatchStatus, type RouteSheet } from '../../../shared/collections';
import { readProofFile, type ProofDraft } from './proof-file';

const money = (centavos: number) => `PHP ${decimalMoney(centavos)}`;
const today = () => new Date().toISOString().slice(0, 10);
const statusTone = (status: BatchStatus) => status === 'RECONCILED' ? 'good' : status === 'CLOSED' ? 'neutral' : status === 'SUBMITTED' || status === 'REMITTED' ? 'warn' : 'blue';
const accountTone = (status: BatchAccountStatus) => status === 'COLLECTED' ? 'good' : status === 'PARTIAL' ? 'warn' : status === 'OVERPAID' ? 'blue' : 'neutral';

/**
 * The route screen for one batch. Every figure on it is the value the API returned with the
 * command that changed it, and the only arithmetic on screen is the money label: the server
 * owns the totals, the state machine and the remittance comparison.
 */
export function CollectionBatchPanel({ batchId, user, onUnauthorized, onChanged }: { batchId: string; user: Actor; onUnauthorized(): void; onChanged(): void }) {
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [sheet, setSheet] = useState<RouteSheet | null>(null);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [submitNotes, setSubmitNotes] = useState('');
  const [counted, setCounted] = useState(''); const [remittedOn, setRemittedOn] = useState(today()); const [remitNotes, setRemitNotes] = useState('');
  const [reconcileNotes, setReconcileNotes] = useState('');
  const [accountId, setAccountId] = useState(''); const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('CASH'); const [reference, setReference] = useState('');
  const [proof, setProof] = useState<ProofDraft | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const canManage = user.permissions.includes('collection.manage');
  const canReconcile = user.permissions.includes('collection.reconcile');
  const canCollect = canManage && user.permissions.includes('payment.create');

  useEffect(() => {
    let current = true; setLoading(true); setError('');
    void window.bcis.getCollectionBatch(batchId).then((result) => {
      if (!current) return;
      if (result.ok) { setDetail(result.data); setAccountId((value) => value || result.data.accounts[0]?.id || ''); }
      else { setDetail(null); setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => { if (current) { setDetail(null); setError('The collection route could not be loaded.'); } }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [batchId]);

  /** The route sheet is read from the server as its own document, so the print is a copy. */
  async function openSheet() {
    setBusy(true); setError('');
    try {
      const result = await window.bcis.getCollectionRouteSheet(batchId);
      if (result.ok) setSheet(result.data);
      else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    } catch { setError('The route sheet could not be prepared.'); }
    finally { setBusy(false); }
  }

  /** Every command here answers with the stored batch, so the panel redraws from server truth. */
  async function run(command: () => Promise<{ ok: true; data: BatchDetail } | { ok: false; error: { status: number; message: string; fields?: Record<string, string[]> } }>, success: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await command();
      if (result.ok) { setDetail(result.data); setNotice(success); onChanged(); }
      else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    } catch { setError('The command could not be completed. Nothing was saved.'); }
    finally { setBusy(false); }
  }

  async function collect() {
    if (!detail) return;
    const amountCentavos = parseCentavos(amount);
    if (!accountId) { setError('Choose the account on the route you are collecting from.'); return; }
    if (amountCentavos === null || amountCentavos < 1) { setError('Enter the amount received in pesos, for example 750.00.'); return; }
    if (method === 'GCASH' && !/^[A-Za-z0-9-]{4,40}$/.test(reference.trim())) { setError('Enter the GCash reference number exactly as it appears on the receipt.'); return; }
    if (method === 'GCASH' && !proof) { setError('Attach the GCash receipt before recording the claim on this route.'); return; }
    const subscriberId = detail.accounts.find((account) => account.subscriberId === accountId)?.subscriberId;
    if (!subscriberId) { setError('Choose the account on the route you are collecting from.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await window.bcis.recordPayment({
        subscriberId, method, amountCentavos, receivedOn: today(), notes: `Collected on ${detail.batchNumber}`,
        collectionBatchId: detail.id,
        ...(method === 'GCASH' ? { referenceNumber: reference.trim() } : {}),
        ...(method === 'GCASH' && proof ? { proof: { fileName: proof.fileName, mimeType: proof.mimeType, base64: proof.base64 } } : {}),
      });
      if (!result.ok) { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); return; }
      setNotice(result.data.payment.status === 'PENDING'
        ? `GCash claim of ${money(result.data.payment.amountCentavos)} recorded on ${detail.batchNumber} and awaiting confirmation.`
        : `Receipt ${result.data.payment.receiptNumber} for ${money(result.data.payment.amountCentavos)} recorded on ${detail.batchNumber}.`);      setAmount(''); setReference(''); setProof(null); if (fileRef.current) fileRef.current.value = '';
      const refreshed = await window.bcis.getCollectionBatch(batchId);
      if (refreshed.ok) setDetail(refreshed.data);
      onChanged();
    } catch { setError('The collection could not be recorded. Nothing was saved.'); }
    finally { setBusy(false); }
  }

  async function attach(file: File | null) {
    if (!file) { setProof(null); if (fileRef.current) fileRef.current.value = ''; return; }
    const result = await readProofFile(file);
    if (!result.ok) { setError(result.message); return; }
    setError(''); setProof(result.proof);
  }

  if (loading) return <p className="table-state" role="status">Loading collection route…</p>;
  if (!detail) return <p className="table-state">{error || 'This collection route is not available.'}</p>;

  const countedCentavos = parseCentavos(counted);
  const collectable = detail.status === 'OPEN' || detail.status === 'IN_PROGRESS';
  const account = detail.accounts.find((row) => row.subscriberId === accountId) ?? null;

  return <section className="panel collection-detail" aria-busy={loading}>
    <header className="panel-top collection-heading">
      <div><h2>{detail.batchNumber}</h2><p className="muted">{detail.areaName} · {detail.collectorName} · {detail.collectionDate}</p></div>
      <div className="row-actions">
        <span className={`badge ${statusTone(detail.status)}`}>{detail.status.replace('_', ' ')}</span>
        <button className="refresh-button" aria-label="Refresh collection route" disabled={busy} onClick={() => void run(() => window.bcis.getCollectionBatch(detail.id), 'Route refreshed.')}><RefreshCw size={14}/>Refresh</button>
        <button className="refresh-button" aria-label="Print route sheet" disabled={busy} onClick={() => void openSheet()}><Printer size={14}/>Route sheet</button>
      </div>
    </header>
    {error && <div className="form-alert" role="alert">{error}</div>}
    {notice && <div className="success-notice" role="status">{notice}</div>}

    <div className="invoice-summary collection-figures">
      <div><span>Expected receivable</span><strong className="money-cell">{money(detail.expectedReceivableCentavos)}</strong><small>{detail.accountCount} account(s) on the route</small></div>
      <div><span>Cash collected</span><strong className="money-cell">{money(detail.cashCollectedCentavos)}</strong><small>Paid in cash on this route</small></div>
      <div><span>Non-cash collected</span><strong className="money-cell">{money(detail.nonCashCollectedCentavos)}</strong><small>{detail.pendingClaimCentavos ? `${money(detail.pendingClaimCentavos)} awaiting confirmation` : 'Confirmed GCash'}</small></div>
      <div><span>Uncollected</span><strong className="money-cell">{money(detail.uncollectedCentavos)}</strong><small>{detail.accountsCollected} collected · {detail.accountsPartial} partial · {detail.accountsUnpaid} unpaid</small></div>
      <div><span>Remittance variance</span><strong className="money-cell">{detail.shortageCentavos ? `− ${money(detail.shortageCentavos)}` : detail.overageCentavos ? `+ ${money(detail.overageCentavos)}` : money(0)}</strong><small>{detail.remittance ? (detail.balanced ? 'Balanced' : detail.shortageCentavos ? 'Shortage' : 'Overage') : 'Not counted yet'}</small></div>
    </div>

    {detail.remittance && <div className={`collection-remittance ${detail.balanced ? 'balanced' : 'unbalanced'}`} role="note">
      {detail.balanced ? <CheckCircle2 size={18}/> : <AlertTriangle size={18}/>}
      <div>
        <strong>Remittance {detail.remittance.remittanceNumber} · {detail.remittance.remittedOn}</strong>
        <p>Expected {money(detail.remittance.expectedCashCentavos)} · counted {money(detail.remittance.cashCentavos)} · recorded by {detail.remittance.recordedName}</p>
        {!detail.balanced && <p className="collection-variance">{detail.shortageCentavos ? `Shortage of ${money(detail.shortageCentavos)}` : `Overage of ${money(detail.overageCentavos)}`} — this stays on the record until it is explained in the reconciliation.</p>}
        {detail.remittance.notes && <p>Collector noted: {detail.remittance.notes}</p>}
        {detail.reconciledAt && <p>Reconciled by {detail.reconciledName} on {new Date(detail.reconciledAt).toLocaleString()}: {detail.reconciliationNotes}</p>}
      </div>
    </div>}

    <div className="collection-actions">
      {canManage && detail.status === 'OPEN' && <button className="primary-button" aria-label="Start collection route" disabled={busy} onClick={() => void run(() => window.bcis.startCollectionBatch(detail.id), 'Collection started. The route is now in progress.')}>Start collection</button>}
      {canManage && detail.status === 'IN_PROGRESS' && <div className="collection-inline">
        <label>Submission note<input aria-label="Submission note" value={submitNotes} onChange={(event) => setSubmitNotes(event.target.value)} maxLength={500} placeholder="e.g. three accounts were not at home" /></label>
        <button className="primary-button" aria-label="Submit collection route" disabled={busy} onClick={() => void run(() => window.bcis.submitCollectionBatch(detail.id, { notes: submitNotes.trim() }), 'Route submitted. No further collections are accepted.')}>Submit route</button>
      </div>}
      {canReconcile && detail.status === 'RECONCILED' && <button className="primary-button" aria-label="Close collection batch" disabled={busy} onClick={() => void run(() => window.bcis.closeCollectionBatch(detail.id, {}), 'Route closed. The sheet is kept as history.')}>Close batch</button>}
      {detail.status === 'CLOSED' && <p className="muted">This route is closed. Its sheet, remittance and collections are kept as history.</p>}
    </div>

    {canManage && detail.status === 'SUBMITTED' && <section className="panel billing-command collection-remit">
      <h3>Count the cash handed in</h3>
      <div className="billing-command-fields">
        <label>Expected cash (PHP)<input aria-label="Expected cash" readOnly value={decimalMoney(detail.cashCollectedCentavos)} /></label>
        <label>Counted cash (PHP)<input aria-label="Counted cash" inputMode="decimal" value={counted} onChange={(event) => setCounted(event.target.value)} placeholder="0.00" /><small>A difference is stored as a shortage or an overage, never adjusted away.</small></label>
        <label>Counted on<input aria-label="Counted on" type="date" max={today()} value={remittedOn} onChange={(event) => setRemittedOn(event.target.value)} /></label>
        <label>Notes<input aria-label="Remittance notes" value={remitNotes} onChange={(event) => setRemitNotes(event.target.value)} maxLength={500} /></label>
      </div>
      <div className="billing-command-actions">
        <button className="primary-button" aria-label="Record remittance" disabled={busy || countedCentavos === null} onClick={() => void run(() => window.bcis.remitCollectionBatch(detail.id, { remittedOn, cashCentavos: countedCentavos ?? 0, notes: remitNotes.trim() }), 'Remittance recorded. A supervisor now signs it off.')}>Record remittance</button>
      </div>
    </section>}

    {canReconcile && detail.status === 'REMITTED' && <section className="panel billing-command collection-reconcile">
      <h3>Sign off the remittance</h3>
      <p className="muted">A remittance must be reconciled by someone other than the person who counted it, and the reason is kept with the record.</p>
      <label>Reconciliation reason<textarea aria-label="Reconciliation reason" value={reconcileNotes} onChange={(event) => setReconcileNotes(event.target.value)} maxLength={500} placeholder="e.g. shortage of 50.00 explained by a torn note" /></label>
      <div className="billing-command-actions">
        <button className="primary-button" aria-label="Reconcile remittance" disabled={busy || reconcileNotes.trim().length < 3} onClick={() => void run(() => window.bcis.reconcileCollectionBatch(detail.id, { notes: reconcileNotes.trim() }), 'Remittance reconciled and signed.')}>Reconcile remittance</button>
      </div>
    </section>}

    {canCollect && collectable && <section className="panel billing-command collection-collect">
      <h3>Record a collection on this route</h3>
      <div className="billing-command-fields">
        <label>Account on the route<select aria-label="Account on the route" value={accountId} onChange={(event) => setAccountId(event.target.value)}>{detail.accounts.map((row) => <option key={row.id} value={row.subscriberId}>{row.subscriberCode} · {row.subscriberName}</option>)}</select>{account && <small>Due on the sheet: {money(account.totalDueCentavos)} · already collected {money(account.collectedCentavos)}</small>}</label>
        <label>Method<select aria-label="Collection method" value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)}>{paymentMethodValues.map((value) => <option key={value} value={value}>{value === 'CASH' ? 'Cash' : 'GCash'}</option>)}</select></label>
        <label>Amount received (PHP)<input aria-label="Collection amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></label>
        {method === 'GCASH' && <label>GCash reference number<input aria-label="Collection GCash reference" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={40} /></label>}
        {method === 'GCASH' && <label>GCash receipt<input ref={fileRef} aria-label="Collection GCash receipt" type="file" accept="image/png,image/jpeg,application/pdf" onChange={(event) => void attach(event.target.files?.[0] ?? null)} /></label>}
      </div>
      <div className="billing-command-actions">
        <button className="primary-button" aria-label="Record collection on route" disabled={busy || !accountId} onClick={() => void collect()}>{method === 'CASH' ? <Banknote size={15}/> : <Smartphone size={15}/>} {busy ? 'Recording…' : 'Record collection'}</button>
        {account && account.totalDueCentavos > 0 && <button className="refresh-button" aria-label="Fill full due amount" onClick={() => setAmount(decimalMoney(Math.max(0, account.totalDueCentavos - account.collectedCentavos)))}>Use full balance</button>}
      </div>
      <p className="muted">The receipt number, the invoice allocation and the route totals are all decided by the API. A GCash claim waits for confirmation by a second person before it counts as collected.</p>
    </section>}

    <div className="table-scroll collection-accounts">
      <table><thead><tr><th>#</th><th>Account</th><th>Name</th><th>Address</th><th>Current bill</th><th>Arrears</th><th>Total due</th><th>Collected</th><th>Status</th></tr></thead><tbody>
        {detail.accounts.map((row, index) => <tr key={row.id} className={row.subscriberId === accountId ? 'row-selected' : ''}>
          <td>{index + 1}</td><td><strong>{row.subscriberCode}</strong></td><td>{row.subscriberName}</td><td>{row.address || '—'}</td>
          <td className="money-cell">{money(row.currentBillCentavos)}</td><td className="money-cell">{money(row.arrearsCentavos)}</td>
          <td className="money-cell">{money(row.totalDueCentavos)}</td><td className="money-cell">{money(row.collectedCentavos)}</td>
          <td><span className={`badge ${accountTone(row.status)}`}>{row.status}</span></td>
        </tr>)}
      </tbody></table>
    </div>

    {sheet && <section className="collection-sheet-card">
      <div className="panel-top"><div><h3>Route sheet preview</h3><p className="muted">This is the printable document. Printing shows it without the workspace navigation.</p></div>
        <div className="row-actions"><button className="primary-button" aria-label="Print route sheet now" onClick={() => window.print()}><Printer size={15}/>Print</button><button className="text-button" aria-label="Hide route sheet preview" onClick={() => setSheet(null)}>Hide</button></div>
      </div>
      <RouteSheetPrint sheet={sheet}/>
    </section>}
  </section>;
}

/** The printed sheet: header, one line per account with a tick box, and the day's totals. */
function RouteSheetPrint({ sheet }: { sheet: RouteSheet }) {
  return <div className="route-sheet-print">
    <header>
      <div><p className="eyebrow">BCIS · Bukidnon Cable &amp; Internet Services</p><h2>Collection Route Sheet</h2></div>
      <dl>
        <div><dt>Batch</dt><dd>{sheet.batchNumber}</dd></div>
        <div><dt>Date</dt><dd>{sheet.collectionDate}</dd></div>
        <div><dt>Collector</dt><dd>{sheet.collectorName}</dd></div>
        <div><dt>Area</dt><dd>{sheet.areaName}</dd></div>
      </dl>
    </header>
    <table><thead><tr><th>#</th><th>Account</th><th>Name</th><th>Address</th><th>Current bill</th><th>Arrears</th><th>Total due</th><th>Collected</th><th>Status</th></tr></thead><tbody>
      {sheet.accounts.map((row, index) => <tr key={row.id}>
        <td>{index + 1}</td><td>{row.subscriberCode}</td><td>{row.subscriberName}</td><td>{row.address || '—'}</td>
        <td className="money-cell">{money(row.currentBillCentavos)}</td><td className="money-cell">{money(row.arrearsCentavos)}</td>
        <td className="money-cell">{money(row.totalDueCentavos)}</td><td className="money-cell">{money(row.collectedCentavos)}</td>
        <td>{row.status}</td>
      </tr>)}
    </tbody><tfoot><tr>
      <td colSpan={4}>Totals · {sheet.totals.accountCount} account(s)</td>
      <td className="money-cell">{money(sheet.totals.expectedReceivableCentavos)}</td><td/>
      <td className="money-cell">{money(sheet.totals.expectedReceivableCentavos)}</td>
      <td className="money-cell">{money(sheet.totals.totalCollectedCentavos)}</td><td/>
    </tr></tfoot></table>
    <footer>
      <span><Wallet size={13}/>Cash {money(sheet.totals.cashCollectedCentavos)} · Non-cash {money(sheet.totals.nonCashCollectedCentavos)} · Uncollected {money(sheet.totals.uncollectedCentavos)}</span>
      <span><ClipboardCheck size={13}/>Generated {new Date(sheet.generatedAt).toLocaleString()}</span>
    </footer>
  </div>;
}

export const collectionStatusValues = batchStatusValues;
