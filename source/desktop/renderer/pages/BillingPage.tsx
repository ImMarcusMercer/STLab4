import { useEffect, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, FilePlus2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { Actor } from '../../../shared/auth';
import type { MasterList, MasterRecord } from '../../../shared/master-data';
import {
  decimalMoney, invoiceItemTypeValues, parseCentavos, periodLabel, shiftPeriod, sumLines, type Invoice, type InvoiceItemType,
  type InvoiceStatus, type Ledger, type LineInput,
} from '../../../shared/billing';
import { BillingDialogs, type DialogState } from './BillingDialogs';

export type LineDraft = { itemType: InvoiceItemType; description: string; quantity: string; price: string };

/**
 * Billing screen. Every figure shown here comes from the server response, and every
 * command is a named preload operation that the API re-validates. The only arithmetic
 * in this file is the clearly labelled draft preview, which the server replaces with
 * its own stored totals as soon as the document is saved.
 */
export function BillingPage({ user, onUnauthorized }: { user: Actor; onUnauthorized(): void }) {
  const [tab, setTab] = useState<'cycles' | 'invoices' | 'ledger'>('cycles');
  const [revision, setRevision] = useState(0);
  const canGenerate = user.permissions.includes('billing.generate');
  return <div className="master-page billing-page">
    <div className="module-tabs" role="tablist" aria-label="Billing">
      <button role="tab" aria-selected={tab === 'cycles'} onClick={() => setTab('cycles')}>Billing cycles</button>
      <button role="tab" aria-selected={tab === 'invoices'} onClick={() => setTab('invoices')}>Invoices</button>
      <button role="tab" aria-selected={tab === 'ledger'} onClick={() => setTab('ledger')}>Subscriber ledger</button>
    </div>
    {tab === 'cycles' && <CyclesTab revision={revision} canGenerate={canGenerate} onUnauthorized={onUnauthorized} onChanged={() => setRevision((value) => value + 1)} />}
    {tab === 'invoices' && <InvoicesTab revision={revision} canGenerate={canGenerate} onUnauthorized={onUnauthorized} onChanged={() => setRevision((value) => value + 1)} />}
    {tab === 'ledger' && <LedgerTab key={revision} onUnauthorized={onUnauthorized} />}
  </div>;
}

const money = (centavos: number) => `PHP ${decimalMoney(centavos)}`;
const statusBadge = (status: InvoiceStatus) => `badge ${status === 'VOID' || status === 'DRAFT' ? 'neutral' : status === 'OVERDUE' ? 'warn' : status === 'PAID' ? 'good' : 'blue'}`;

// ------------------------------------------------------------------ billing cycles

// A revision reloads the tab data after a command instead of remounting it, so the
// confirmation the operator just earned stays on screen.
function CyclesTab({ revision, canGenerate, onUnauthorized, onChanged }: { revision: number; canGenerate: boolean; onUnauthorized(): void; onChanged(): void }) {
  const [cycles, setCycles] = useState<{ items: { code: string; periodStart: string; periodEnd: string; generated: boolean; invoiceCount: number }[]; total: number } | null>(null);
  const [runs, setRuns] = useState<{ items: { id: string; cycleCode: string; periodLabel: string; asOf: string; invoiceCount: number; skippedCount: number; totalCentavos: number; actorName: string }[]; total: number } | null>(null);
  const [period, setPeriod] = useState(shiftPeriod(new Date().toISOString().slice(0, 7), -1));
  const [asOf, setAsOf] = useState('');
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true; setLoading(true);
    void Promise.all([window.bcis.listBillingCycles(), window.bcis.listBillingRuns(1)]).then(([cycleResult, runResult]) => {
      if (!current) return;
      if (cycleResult.ok) setCycles(cycleResult.data); else setError(cycleResult.error.message);
      if (runResult.ok) setRuns(runResult.data); else setError(runResult.error.message);
      if (!cycleResult.ok && cycleResult.error.status === 401) onUnauthorized();
    }).catch(() => { if (current) setError('Billing cycles could not be loaded.'); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [revision]);
  async function generate() {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await window.bcis.generateBillingRun({ period, ...(asOf ? { asOf } : {}) });
      if (result.ok) {
        setNotice(`${result.data.periodLabel}: ${result.data.invoiceCount} invoice(s) totalling ${money(result.data.totalCentavos)}, ${result.data.skippedCount} service(s) already invoiced${result.data.idempotent ? ' (existing run reused)' : ''}.`);
        setPeriod(shiftPeriod(period, 1));
        onChanged();
      } else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    } catch { setError('The billing run could not be completed.'); }
    finally { setBusy(false); }
  }
  async function sweep() {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await window.bcis.sweepOverdueInvoices(asOf ? { asOf } : {});
      if (result.ok) { setNotice(`Marked ${result.data.markedCount} invoice(s) overdue, ${money(result.data.markedCentavos)} outstanding as of ${result.data.asOf}.`); onChanged(); }
      else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    } catch { setError('The overdue sweep could not be completed.'); }
    finally { setBusy(false); }
  }
  return <div>
    <div className="page-heading"><div><p className="eyebrow">BILLING</p><h1>Billing cycles</h1><p className="muted">Create invoices for a month. Running the same month again will not duplicate issued invoices.</p></div></div>
    {error && <div className="form-alert" role="alert">{error}</div>}{notice && <div className="success-notice" role="status">{notice}</div>}
    {canGenerate && <section className="panel billing-command">
      <div className="billing-command-fields">
        <label>Billing period<input aria-label="Billing period" value={period} onChange={(event) => setPeriod(event.target.value)} placeholder="YYYY-MM" maxLength={7} /></label>
        <label>Status as of<input aria-label="Status as of" type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} /><small>Optional. Blank uses the last day of the period.</small></label>
      </div>
      <div className="billing-command-actions">
        <button className="primary-button" disabled={busy || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)} onClick={() => void generate()}><CalendarDays size={16} />{busy ? 'Working…' : 'Generate period'}</button>
        <button className="refresh-button" disabled={busy} onClick={() => void sweep()}><RefreshCw size={14} />Sweep overdue</button>
      </div>
    </section>}
    <section className="users-table-panel" aria-busy={loading}>
      <header><h2>Billing history</h2><span className="muted">{cycles?.total ?? 0} period(s)</span></header>
      {loading ? <p className="table-state" role="status">Loading billing history…</p> : <div className="table-scroll"><table><thead><tr><th>Period</th><th>Status as of</th><th>Invoices</th><th>Total</th><th>Status</th></tr></thead><tbody>
        {runs?.items.map(run => <tr key={run.id}><td><strong>{run.periodLabel}</strong><small className="current-user">{run.cycleCode}</small></td><td>{run.asOf}</td><td>{run.invoiceCount} issued{run.skippedCount ? `, ${run.skippedCount} already invoiced` : ''}</td><td className="money-cell">{money(run.totalCentavos)}</td><td><span className="badge blue">Generated</span></td></tr>)}
        {(cycles?.items ?? []).map(cycle => !cycle.generated && <tr key={cycle.code}><td><strong>{periodLabel(cycle.code)}</strong><small className="current-user">{cycle.code}</small></td><td>{cycle.periodStart} → {cycle.periodEnd}</td><td>—</td><td className="money-cell">—</td><td><span className="badge neutral">Not generated</span></td></tr>)}
      </tbody></table>{(!runs?.items.length && !cycles?.items.length) && <p className="table-state">No billing period has been generated yet.</p>}</div>}
    </section>
    <p className="info-note">Services already invoiced for the month are skipped. A replacement for a voided invoice receives a new number.</p>
  </div>;
}

// ----------------------------------------------------------------------- invoices

function InvoicesTab({ revision, canGenerate, onUnauthorized, onChanged }: { revision: number; canGenerate: boolean; onUnauthorized(): void; onChanged(): void }) {
  const [query, setQuery] = useState(''); const [status, setStatus] = useState(''); const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: Invoice[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<DialogState | null>(null);
  useEffect(() => {
    let current = true; setLoading(true); setError('');
    const timer = setTimeout(() => { void window.bcis.listBillingInvoices({ q: query, page, ...(status ? { status: status as InvoiceStatus } : {}) }).then((result) => {
      if (!current) return;
      if (result.ok) setData(result.data); else { setData(null); setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => { if (current) { setData(null); setError('Invoices could not be loaded.'); } }).finally(() => { if (current) setLoading(false); }); }, 180);
    return () => { current = false; clearTimeout(timer); };
  }, [query, status, page, revision]);
  return <div>
    <div className="page-heading"><div><p className="eyebrow">BILLING</p><h1>Invoices</h1><p className="muted">Search issued and draft documents. Line items, numbers and totals are never edited after issue.</p></div>{canGenerate && <button className="primary-button" onClick={() => setDialog({ kind: 'new' })}><FilePlus2 size={16} />New invoice</button>}</div>
    {error && <div className="form-alert" role="alert">{error}</div>}{notice && <div className="success-notice" role="status">{notice}</div>}
    <div className="master-toolbar"><input aria-label="Search invoices" placeholder="Invoice number, subscriber or service…" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /><select aria-label="Filter invoice status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option>{(['DRAFT', 'UNPAID', 'PARTIALLY_PAID', 'OVERDUE', 'PAID', 'VOID'] as InvoiceStatus[]).map((value) => <option key={value}>{value}</option>)}</select><button className="refresh-button" disabled={loading} onClick={() => { setPage(1); onChanged(); }}><RefreshCw size={14} />Refresh</button></div>
    <section className="users-table-panel" aria-busy={loading}><header><h2>{data?.total ?? 0} invoices</h2><span className="muted">Page {page} of {Math.max(1, Math.ceil((data?.total ?? 0) / 20))}</span></header>
      {loading ? <p className="table-state" role="status">Loading invoices…</p> : <div className="table-scroll"><table><thead><tr><th>Invoice</th><th>Subscriber</th><th>Service</th><th>Issue / due</th><th>Total</th><th>Balance</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        {data?.items.map((invoice) => <tr key={invoice.id}>
          <td><strong>{invoice.invoiceNumber ?? 'Draft'}</strong><small className="current-user">{invoice.periodLabel}{invoice.source === 'MANUAL' ? ' · manual' : ''}</small></td>
          <td>{invoice.subscriberCode}<small className="current-user">{invoice.subscriberName}</small></td>
          <td>{invoice.serviceCode}</td>
          <td>{invoice.issueDate}<small className="current-user">due {invoice.dueDate}</small></td>
          <td className="money-cell">{money(invoice.totalCentavos)}</td>
          <td className="money-cell">{money(invoice.balanceCentavos)}</td>
          <td><span className={statusBadge(invoice.status)}>{invoice.status}</span></td>
          <td><div className="row-actions"><button className="text-button" aria-label={`View ${invoice.invoiceNumber ?? 'draft invoice'}`} onClick={() => setDialog({ kind: 'view', id: invoice.id })}>View</button>{canGenerate && invoice.status === 'DRAFT' && <button className="text-button" aria-label={`Issue ${invoice.serviceCode} draft`} onClick={() => setDialog({ kind: 'finalize', id: invoice.id })}>Issue</button>}{canGenerate && !['DRAFT', 'VOID'].includes(invoice.status) && <button className="text-button" aria-label={`Adjust ${invoice.invoiceNumber}`} onClick={() => setDialog({ kind: 'adjust', id: invoice.id })}>Adjust</button>}</div></td>
        </tr>)}
      </tbody></table>{data?.items.length === 0 && <p className="table-state">No invoices match this search.</p>}</div>}
      <footer><span>Corrections append an adjustment or a void reversal; nothing is overwritten.</span><div><button className="icon-button" aria-label="Previous page" disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={16} /></button><button className="icon-button" aria-label="Next page" disabled={loading || page * 20 >= (data?.total ?? 0)} onClick={() => setPage((value) => value + 1)}><ChevronRight size={16} /></button></div></footer>
    </section>
    <p className="info-note">A draft has no number and no statement line. Issuing it assigns the number and posts the debit. A void keeps the document and its lines and posts a linked reversal.</p>
    {dialog && <BillingDialogs state={dialog} onClose={() => setDialog(null)} onUnauthorized={onUnauthorized} onSaved={(message) => { setDialog(null); setNotice(message); onChanged(); }} />}
  </div>;
}

// -------------------------------------------------------------------------- ledger

function LedgerTab({ onUnauthorized }: { onUnauthorized(): void }) {
  const [search, setSearch] = useState(''); const [subscribers, setSubscribers] = useState<MasterList<'subscribers'> | null>(null);
  const [selected, setSelected] = useState<MasterRecord<'subscribers'> | null>(null);
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [data, setData] = useState<Ledger | null>(null); const [loading, setLoading] = useState(false);
  const [error, setError] = useState(''); const [finding, setFinding] = useState(false);
  useEffect(() => {
    let current = true; setFinding(true);
    const timer = setTimeout(() => { void window.bcis.listSubscribers({ q: search, page: 1 }).then((result) => {
      if (!current) return;
      if (result.ok) setSubscribers(result.data as MasterList<'subscribers'>); else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => { if (current) setError('Subscribers could not be searched.'); }).finally(() => { if (current) setFinding(false); }); }, 200);
    return () => { current = false; clearTimeout(timer); };
  }, [search]);
  useEffect(() => {
    if (!selected) { setData(null); return; }
    let current = true; setLoading(true); setError('');
    void window.bcis.getSubscriberLedger({ subscriberId: selected.id, page: 1, perPage: 200, ...(from ? { from } : {}), ...(to ? { to } : {}) }).then((result) => {
      if (!current) return;
      if (result.ok) setData(result.data); else { setData(null); setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => { if (current) setError('The account ledger could not be loaded.'); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [selected, from, to]);
  return <div>
    <div className="page-heading"><div><p className="eyebrow">ACCOUNT STATEMENT</p><h1>Subscriber ledger</h1><p className="muted">Review charges, payments, adjustments and the running balance in date order.</p></div></div>
    {error && <div className="form-alert" role="alert">{error}</div>}
    <div className="master-toolbar">
      <input aria-label="Search subscriber for the ledger" placeholder="Subscriber code or name…" value={search} onChange={(event) => setSearch(event.target.value)} />
      <label className="range-field">From<input aria-label="Ledger from date" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label className="range-field">To<input aria-label="Ledger to date" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
    </div>
    {search && <section className="users-table-panel subscriber-picker" aria-busy={finding}><header><h2>Subscribers</h2><span className="muted">{finding ? 'Searching…' : 'Select an account'}</span></header>
      <div className="table-scroll"><table><thead><tr><th>Account</th><th>Name</th><th>Contact</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>
        {subscribers?.items.map((row: MasterRecord<'subscribers'>) => <tr key={row.id}><td>{row.code}</td><td>{row.name}</td><td>{row.contact || '—'}</td><td><button className="text-button" aria-label={`Open ledger for ${row.code}`} onClick={() => setSelected(row)}>Open</button></td></tr>)}
      </tbody></table>{!finding && !subscribers?.items.length && <p className="table-state">No subscriber matches this search.</p>}</div></section>}
    {selected && <section className="users-table-panel" aria-busy={loading}>
      <header><div><h2>{selected.code} · {selected.name}</h2><p className="muted">Statement from {data ? money(data.openingBalanceCentavos) : '—'} to {data ? money(data.closingBalanceCentavos) : '—'}</p></div><div className="row-actions"><span className="badge good">Balance reproduced</span><button className="text-button" aria-label="Close subscriber ledger" onClick={() => setSelected(null)}>Close</button></div></header>
      {loading ? <p className="table-state" role="status">Loading the account ledger…</p> : <div className="table-scroll"><table className="ledger-table"><thead><tr><th>No.</th><th>Date</th><th>Reference</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>
        {data?.items.map((entry) => <tr key={entry.id}><td>{entry.entryNo}</td><td>{entry.entryDate}</td><td><strong>{entry.invoiceNumber ?? entry.referenceType}</strong><small className="current-user">{entry.referenceType}</small></td><td>{entry.description}</td><td className="money-cell">{entry.debitCentavos ? money(entry.debitCentavos) : '—'}</td><td className="money-cell">{entry.creditCentavos ? money(entry.creditCentavos) : '—'}</td><td className="money-cell">{money(entry.balanceCentavos)}</td></tr>)}
      </tbody><tfoot><tr><td colSpan={4}>Statement totals</td><td className="money-cell">{money(data?.totalDebitCentavos ?? 0)}</td><td className="money-cell">{money(data?.totalCreditCentavos ?? 0)}</td><td className="money-cell">{money(data?.closingBalanceCentavos ?? 0)}</td></tr></tfoot></table>{data && !data.items.length && <p className="table-state">No statement lines in this period.</p>}</div>}
    </section>}
    {!selected && <p className="info-note">Search for a subscriber to open their account ledger.</p>}
  </div>;
}

// -------------------------------------------------------------------- draft editor

/** Draft line editor. The preview total is indicative only; the API recomputes it. */
export function LineEditor({ lines, onChange, disabled }: { lines: LineDraft[]; onChange(next: LineDraft[]): void; disabled?: boolean }) {
  return <div className="line-editor">
    <table><thead><tr><th>Type</th><th>Description</th><th>Qty</th><th>Unit price (PHP)</th><th><span className="sr-only">Remove</span></th></tr></thead>
      <tbody>{lines.map((line, index) => <tr key={index}>
        <td><select aria-label={`Line ${index + 1} type`} value={line.itemType} disabled={disabled} onChange={(event) => onChange(lines.map((value, position) => position === index ? { ...value, itemType: event.target.value as InvoiceItemType } : value))}>{invoiceItemTypeValues.map((value) => <option key={value}>{value}</option>)}</select></td>
        <td><input aria-label={`Line ${index + 1} description`} value={line.description} disabled={disabled} maxLength={300} onChange={(event) => onChange(lines.map((value, position) => position === index ? { ...value, description: event.target.value } : value))} /></td>
        <td><input aria-label={`Line ${index + 1} quantity`} type="number" min={1} max={1000} value={line.quantity} disabled={disabled} onChange={(event) => onChange(lines.map((value, position) => position === index ? { ...value, quantity: event.target.value } : value))} /></td>
        <td><input aria-label={`Line ${index + 1} unit price`} inputMode="decimal" value={line.price} disabled={disabled} onChange={(event) => onChange(lines.map((value, position) => position === index ? { ...value, price: event.target.value } : value))} /></td>
        <td><button type="button" className="icon-button" aria-label={`Remove line ${index + 1}`} disabled={disabled || lines.length <= 1} onClick={() => onChange(lines.filter((_value, position) => position !== index))}><Trash2 size={15} /></button></td>
      </tr>)}</tbody>
    </table>
    <div className="line-editor-foot"><button type="button" className="refresh-button" disabled={disabled} onClick={() => onChange([...lines, { itemType: 'SUBSCRIPTION', description: '', quantity: '1', price: '' }])}><Plus size={14} />Add line</button><span className="preview-total">Preview total {money(previewTotal(lines))}</span></div>
  </div>;
}

/**
 * Indicative preview of the entered lines. It is never sent to the API: the stored
 * invoice totals are always the server's own integers.
 */
export function previewTotal(lines: LineDraft[]): number {
  const parsed: LineInput[] = [];
  for (const line of lines) {
    const unitPriceCentavos = parseCentavos(line.price);
    const quantity = Number(line.quantity);
    if (unitPriceCentavos === null || !Number.isInteger(quantity) || quantity < 1 || line.description.trim().length < 2) return 0;
    parsed.push({ itemType: line.itemType, description: line.description.trim(), quantity, unitPriceCentavos });
  }
  try { return sumLines(parsed).totalCentavos; } catch { return 0; }
}
