import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ClipboardX, History, RefreshCw, ShieldAlert } from 'lucide-react';
import type { Actor } from '../../../shared/auth';
import { agingBucketLabels, moneyLabel } from '../../../shared/receivables';
import type {
  AgingBucket, ReceivableList, ReceivableSummary, ServiceControlEvent, ServicePolicy, ServiceTechnician, Suspension, SuspensionStatus,
} from '../../../shared/receivables';
import type { MasterList, MasterRecord } from '../../../shared/master-data';
import { SuspensionPanel } from './SuspensionPanel';

const today = () => new Date().toISOString().slice(0, 10);
const bucketTone = (bucket: AgingBucket) => bucket === 'CURRENT' ? 'good' : bucket === 'D90_PLUS' ? 'danger' : bucket === 'D61_90' ? 'warn' : 'blue';

/**
 * Receivables is the collection supervisor's screen for money that has not arrived: what is
 * overdue, how long it has been, and which accounts have gone past the office's own policy.
 *
 * Every peso on this page is a read of the server. The aging buckets, the follow-up counts and
 * the suspension candidates are all derived there from open invoices, so the screen never
 * counts an invoice, sums a peso or decides that an account should be cut off. What the screen
 * does own is the question it asks and the reason a human writes down.
 */
export function ReceivablesPage({ user, onUnauthorized }: { user: Actor; onUnauthorized(): void }) {
  const [tab, setTab] = useState<'aging' | 'suspensions' | 'policy'>('aging');
  // The register and the policy are office decisions, so a user who may not act on a service is
  // not offered the tab at all rather than being shown a screen that would refuse every command.
  const canControl = user.permissions.includes('service.control');
  return <div className="receivables-page">
    <div className="module-tabs" role="tablist" aria-label="Receivables">
      <button role="tab" aria-selected={tab === 'aging'} onClick={() => setTab('aging')}>Aging report</button>
      {canControl && <button role="tab" aria-selected={tab === 'suspensions'} onClick={() => setTab('suspensions')}>Suspensions &amp; reconnections</button>}
      {canControl && <button role="tab" aria-selected={tab === 'policy'} onClick={() => setTab('policy')}>Service policy</button>}
    </div>
    {tab === 'aging' || !canControl
      ? <AgingTab user={user} onUnauthorized={onUnauthorized} />
      : tab === 'suspensions'
        ? <SuspensionsTab user={user} onUnauthorized={onUnauthorized} />
        : <PolicyTab user={user} onUnauthorized={onUnauthorized} />}
  </div>;
}

function AgingTab({ user, onUnauthorized }: { user: Actor; onUnauthorized(): void }) {
  const [summary, setSummary] = useState<ReceivableSummary | null>(null);
  const [data, setData] = useState<ReceivableList | null>(null);
    const [asOf, setAsOf] = useState(today()); const [bucket, setBucket] = useState('');
  const [areaId, setAreaId] = useState(''); const [collectorId, setCollectorId] = useState('');
  const [page, setPage] = useState(1); const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [areas, setAreas] = useState<MasterList<'areas'> | null>(null); const [collectors, setCollectors] = useState<MasterList<'collectors'> | null>(null);
  const [selected, setSelected] = useState<string | null>(null); const [reason, setReason] = useState('');
  const canControl = user.permissions.includes('service.control');
  const busy = false;

  useEffect(() => {
    let current = true;
    void Promise.all([window.bcis.listAreas({ q: '', page: 1, perPage: 100, status: 'ACTIVE' }), window.bcis.listCollectors({ q: '', page: 1, perPage: 100, status: 'ACTIVE' })]).then(([areaResult, collectorResult]) => {
      if (!current) return;
      if (areaResult.ok) setAreas(areaResult.data); else setError(areaResult.error.message);
      if (collectorResult.ok) setCollectors(collectorResult.data); else setError(collectorResult.error.message);
    }).catch(() => { if (current) setError('The areas and collectors could not be loaded.'); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    let current = true; setLoading(true); setError('');
    // The report is read as of a chosen day, so a past date is a report about that day and the
    // screen shows both dates rather than presenting history as if it were today.
    const timer = setTimeout(() => {
      void window.bcis.getReceivableSummary(`asOf=${asOf}`).then(summaryResult => {
        if (!current) return;
        if (summaryResult.ok) setSummary(summaryResult.data); else { setSummary(null); setError(summaryResult.error.message); if (summaryResult.error.status === 401) onUnauthorized(); }
      }).catch(() => { if (current) setError('The aging report could not be loaded.'); }).finally(() => { if (current) setLoading(false); });
      void window.bcis.listOverdueReceivables({ asOf, page, perPage: 20, ...(bucket ? { bucket: bucket as AgingBucket } : {}), ...(areaId ? { areaId } : {}), ...(collectorId ? { collectorId } : {}) }).then(listResult => {
        if (!current) return;
        if (listResult.ok) setData(listResult.data); else { setData(null); setError(listResult.error.message); if (listResult.error.status === 401) onUnauthorized(); }
      }).catch(() => { if (current) setError('The overdue list could not be loaded.'); });
    }, 180);
    return () => { current = false; clearTimeout(timer); };
  }, [asOf, bucket, areaId, collectorId, page, revision]);

  async function suspend(serviceAccountId: string, subscriberName: string) {
    setError(''); setNotice('');
    const result = await window.bcis.suspendService(serviceAccountId, { reason: reason.trim(), notes: '' });
    if (result.ok) { setNotice(`${subscriberName} was disconnected. Suspension ${result.data.suspensionNumber} was filed with ${moneyLabel(result.data.arrearsAtSuspensionCentavos)} frozen onto it.`); setSelected(null); setReason(''); setRevision(value => value + 1); }
    else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
  }

  return <>
    <div className="page-heading">
      <div><p className="eyebrow">RECEIVABLES</p><h1>Aging report</h1><p className="muted">Everything owed, split by how late it is. The buckets come from open invoices, so they change the moment a payment lands and nothing is recalculated onto a stored figure.</p></div>
    </div>
    {error && <div className="form-alert" role="alert">{error}</div>}
    {notice && <div className="success-notice" role="status">{notice}</div>}

    {summary && <>
      <div className="stat-row">
        <div className="stat-card"><span>Total receivable</span><strong className="money-cell">{moneyLabel(summary.totalReceivableCentavos)}</strong><small>{summary.subscriberCount} account(s) owing</small></div>
        <div className="stat-card"><span>Overdue</span><strong className="money-cell">{moneyLabel(summary.overdueReceivableCentavos)}</strong><small>{summary.overdueSubscriberCount} account(s) past due</small></div>
        <div className="stat-card"><span>Still current</span><strong className="money-cell">{moneyLabel(summary.currentReceivableCentavos)}</strong><small>Not yet due</small></div>
        <div className="stat-card"><span>Follow-up</span><strong className="money-cell">{summary.followUpCount}</strong><small>Past the 30-day mark</small></div>
        <div className="stat-card"><span>Meets policy</span><strong className="money-cell">{summary.suspensionCandidateCount}</strong><small>Eligible for suspension</small></div>
      </div>
      <div className="aging-strip">
        {summary.aging.map(entry => <div key={entry.bucket} className={`aging-cell ${bucketTone(entry.bucket)}`}>
          <span>{agingBucketLabels[entry.bucket]}</span><strong className="money-cell">{moneyLabel(entry.totalCentavos)}</strong><small>{entry.invoiceCount} invoice(s)</small>
        </div>)}
      </div>
      <p className="muted">Reported as of {summary.asOf} · figures produced {summary.dataAsOf}.</p>
    </>}

    <div className="master-toolbar">
      <select aria-label="Filter aging bucket" value={bucket} onChange={event => { setBucket(event.target.value); setPage(1); }}><option value="">All overdue</option>{(['D1_30','D31_60','D61_90','D90_PLUS'] as const).map(value => <option key={value} value={value}>{agingBucketLabels[value]}</option>)}</select>
      <select aria-label="Filter by area" value={areaId} onChange={event => { setAreaId(event.target.value); setPage(1); }}><option value="">All areas</option>{areas?.items.map((row: MasterRecord<'areas'>) => <option key={row.id} value={row.id}>{row.name}</option>)}</select>
      <select aria-label="Filter by collector" value={collectorId} onChange={event => { setCollectorId(event.target.value); setPage(1); }}><option value="">All collectors</option>{collectors?.items.map((row: MasterRecord<'collectors'>) => <option key={row.id} value={row.id}>{row.name}</option>)}</select>
      <input aria-label="Report date" type="date" max={today()} value={asOf} onChange={event => { setAsOf(event.target.value); setPage(1); }}/>
      <button className="refresh-button" aria-label="Refresh aging report" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14}/>Refresh</button>
    </div>

    {loading ? <p className="table-state" role="status">Loading the aging report.</p> : <div className="table-scroll">
      <table><thead><tr><th>Account</th><th>Area / collector</th><th>Arrears</th><th>Months</th><th>Oldest unpaid</th><th>Bucket</th><th>Last payment</th><th>Actions</th></tr></thead><tbody>
        {data?.items.map(row => <tr key={row.serviceAccountId} className={row.serviceAccountId === selected ? 'row-selected' : ''}>
          <td><strong>{row.subscriberName}</strong><small>{row.subscriberCode} · {row.serviceCode}</small></td>
          <td>{row.areaName || '—'}<small>{row.collectorName || 'Unassigned'}</small></td>
          <td className="money-cell">{moneyLabel(row.arrearsCentavos)}<small>{row.oldestUnpaidInvoiceNumber}</small></td>
          <td>{row.monthsUnpaid}</td>
          <td>{row.oldestUnpaidDueDate}<small>{row.overdueDays} day(s) late</small></td>
          <td><span className={`badge ${bucketTone(row.bucket)}`}>{agingBucketLabels[row.bucket]}</span></td>
          <td>{row.lastPaymentDate ?? '—'}<small>{row.lastPaymentDate ? moneyLabel(row.lastPaymentAmountCentavos) : 'No payment yet'}</small></td>
          <td><div className="row-actions">
            {/* The command is offered only where the API says the account actually meets the
                policy, so a user is never walked into a refusal the server decided in advance. */}
            {canControl && row.serviceStatus === 'ACTIVE' && row.suspensionCandidate && <button className="text-button" aria-label={`Suspend ${row.subscriberCode}`} onClick={() => setSelected(row.serviceAccountId)}><ClipboardX size={14}/>Suspend</button>}
            {row.serviceStatus === 'SUSPENDED' && <span className="badge warn">Disconnected</span>}
          </div></td>
        </tr>)}
      </tbody></table>
      {data?.items.length === 0 && <p className="table-state">Nothing is overdue for these filters.</p>}
    </div>}

    {data && data.total > 0 && <div className="pager">
      <span className="muted">Page {data.page} of {Math.max(1, Math.ceil(data.total / data.perPage))} · {data.total} account(s) overdue</span>
      <div className="row-actions">
        <button className="refresh-button" aria-label="Previous page of overdue accounts" disabled={page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={14}/></button>
        <button className="refresh-button" aria-label="Next page of overdue accounts" disabled={page * data.perPage >= data.total} onClick={() => setPage(value => value + 1)}><ChevronRight size={14}/></button>
      </div>
    </div>}

    {selected && canControl && (() => {
      const row = data?.items.find(item => item.serviceAccountId === selected);
      if (!row) return null;
      return <form className="panel billing-command" onSubmit={event => { event.preventDefault(); void suspend(row.serviceAccountId, row.subscriberName); }}>
        <h3>Disconnect {row.subscriberName}</h3>
        <p className="muted">{moneyLabel(row.arrearsCentavos)} overdue for {row.overdueDays} day(s), {row.monthsUnpaid} unpaid month(s). The amount, the months and the policy in force are frozen onto the suspension document so the decision stays explainable later.</p>
        <div className="billing-command-fields">
          <label>Reason for disconnection<input aria-label="Suspension reason" required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} placeholder="Why this service is being cut off" /></label>
        </div>
        <div className="billing-command-actions">
          <button className="primary-button" type="submit" aria-label="Confirm disconnection" disabled={busy || reason.trim().length < 3}><ShieldAlert size={15}/>Disconnect service</button>
          <button className="text-button" type="button" aria-label="Cancel disconnection" onClick={() => { setSelected(null); setReason(''); }}>Cancel</button>
        </div>
        <p className="muted">The API refuses a disconnection that does not meet the current policy, so an account below the threshold or inside the grace period cannot be cut off from here.</p>
      </form>;
    })()}

    <p className="info-note">Aging is derived from open finalized invoices, never from a balance someone typed. Nothing on this report can be edited, and a payment lands on the invoice it settles, so a figure can only ever move because money arrived.</p>
  </>;
}

function SuspensionsTab({ user, onUnauthorized }: { user: Actor; onUnauthorized(): void }) {
  const [data, setData] = useState<{ items: Suspension[]; total: number; page: number; perPage: number } | null>(null);
  const [status, setStatus] = useState(''); const [page, setPage] = useState(1); const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<ServiceControlEvent[]>([]);
  const [technicians, setTechnicians] = useState<ServiceTechnician[]>([]);

  useEffect(() => {
    let current = true; setLoading(true); setError('');
    const timer = setTimeout(() => { void window.bcis.listSuspensions({ page, perPage: 20, ...(status ? { status: status as SuspensionStatus } : {}) }).then(result => {
      if (!current) return;
      if (result.ok) setData(result.data); else { setData(null); setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => { if (current) { setData(null); setError('The suspension register could not be loaded.'); } }).finally(() => { if (current) setLoading(false); }); }, 180);
    return () => { current = false; clearTimeout(timer); };
  }, [status, page, revision]);

  // A technician can only be assigned from the list the API returns, so the screen cannot offer
  // a name that is not an active technician.
  useEffect(() => {
    if (!user.permissions.includes('service.control')) return;
    let current = true;
    void window.bcis.listServiceTechnicians().then(result => { if (current && result.ok) setTechnicians(result.data); }).catch(() => { if (current) setError('The technician list could not be loaded.'); });
    return () => { current = false; };
  }, [user.permissions]);

  // Opening a document reads its history, because the history is the same append-only record
  // the suspension itself was written into.
  useEffect(() => {
    if (!selected) { setHistory([]); return; }
    const row = data?.items.find(item => item.id === selected);
    if (!row) return;
    let current = true;
    void window.bcis.getServiceControlHistory(row.serviceAccountId).then(result => {
      if (!current) return;
      if (result.ok) setHistory(result.data); else { setHistory([]); setError(result.error.message); }
    }).catch(() => { if (current) setError('The service history could not be loaded.'); });
    return () => { current = false; };
  }, [selected, data]);

  return <>
    <div className="page-heading">
      <div><p className="eyebrow">SERVICE CONTROL</p><h1>Suspensions &amp; reconnections</h1><p className="muted">Every disconnection and every restored service, in order. A document is never edited or deleted: it moves forward, and the reason stays attached to it.</p></div>
    </div>
    {error && <div className="form-alert" role="alert">{error}</div>}

    <div className="master-toolbar">
      <select aria-label="Filter suspension status" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">All documents</option>{['ACTIVE','LIFTED','CANCELLED'].map(value => <option key={value} value={value}>{value}</option>)}</select>
      <button className="refresh-button" aria-label="Refresh suspension register" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14}/>Refresh</button>
    </div>

    {loading ? <p className="table-state" role="status">Loading the suspension register.</p> : <div className="table-scroll">
      <table><thead><tr><th>Document</th><th>Account</th><th>Effective</th><th>Arrears frozen</th><th>Months</th><th>Status</th><th>Reconnection</th><th>Actions</th></tr></thead><tbody>
        {data?.items.map(row => <tr key={row.id} className={row.id === selected ? 'row-selected' : ''}>
          <td><strong>{row.suspensionNumber}</strong><small>{row.reason}</small></td>
          <td>{row.subscriberName}<small>{row.subscriberCode} · {row.serviceCode}</small></td>
          <td>{row.effectiveDate}<small>Approved by {row.approvedName}</small></td>
          <td className="money-cell">{moneyLabel(row.arrearsAtSuspensionCentavos)}</td>
          <td>{row.monthsUnpaidAtSuspension}</td>
          <td><span className={`badge ${row.status === 'ACTIVE' ? 'danger' : row.status === 'LIFTED' ? 'good' : 'neutral'}`}>{row.status}</span></td>
          <td>{row.reconnectionNumber ?? '—'}{row.reconnectionStatus ? <small>{row.reconnectionStatus}{row.technicianName ? ` · ${row.technicianName}` : ''}</small> : null}</td>
          <td><div className="row-actions">
            <button className="text-button" aria-label={`Open ${row.suspensionNumber}`} onClick={() => setSelected(row.id)}><History size={14}/>Open</button>
          </div></td>
        </tr>)}
      </tbody></table>
      {data?.items.length === 0 && <p className="table-state">No suspension documents yet. A disconnection raised from the aging report appears here.</p>}
    </div>}

    {data && data.total > 0 && <div className="pager">
      <span className="muted">Page {data.page} of {Math.max(1, Math.ceil(data.total / data.perPage))} · {data.total} document(s)</span>
      <div className="row-actions">
        <button className="refresh-button" aria-label="Previous page of documents" disabled={page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={14}/></button>
        <button className="refresh-button" aria-label="Next page of documents" disabled={page * data.perPage >= data.total} onClick={() => setPage(value => value + 1)}><ChevronRight size={14}/></button>
      </div>
    </div>}

    {selected && data && <SuspensionPanel
      suspension={data.items.find(item => item.id === selected)!}
      technicians={technicians}
      user={user}
      onUnauthorized={onUnauthorized}
      onChanged={() => setRevision(value => value + 1)}
    />}

    {selected && history.length > 0 && <div className="panel">
      <h3>Service history</h3>
      <ol className="history-list">{history.map(event => <li key={event.id}>
        <strong>{event.effectiveDate} · {event.eventType.replace(/_/g, ' ').toLowerCase()} · {event.summary}</strong>
        <span>{event.reason}{event.amountCentavos > 0 ? ` · ${moneyLabel(event.amountCentavos)}` : ''} · by {event.actorName}</span>
      </li>)}</ol>
    </div>}

    <p className="info-note">A service may only be suspended or restored through these commands, and the database refuses any other way of changing it. The receivable frozen onto the document is what was owed on the effective date, so a later payment or policy change cannot rewrite it.</p>
  </>;
}

function PolicyTab({ user, onUnauthorized }: { user: Actor; onUnauthorized(): void }) {
  const [policy, setPolicy] = useState<ServicePolicy | null>(null);
  const [grace, setGrace] = useState(''); const [threshold, setThreshold] = useState(''); const [fee, setFee] = useState('');
  const [auto, setAuto] = useState(false); const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const canControl = user.permissions.includes('service.control');

  useEffect(() => {
    let current = true; setLoading(true);
    void window.bcis.getServicePolicy().then(result => {
      if (!current) return;
      if (result.ok) { setPolicy(result.data); setGrace(String(result.data.gracePeriodDays)); setThreshold(String(result.data.suspensionThresholdCentavos)); setFee(String(result.data.reconnectionFeeCentavos)); setAuto(result.data.autoSuspend); }
      else { setPolicy(null); setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => { if (current) setError('The service policy could not be loaded.'); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const result = await window.bcis.updateServicePolicy({
        gracePeriodDays: Number(grace), suspensionThresholdCentavos: Number(threshold),
        autoSuspend: auto, reconnectionFeeCentavos: Number(fee), reason: reason.trim(),
      });
      if (result.ok) { setPolicy(result.data); setNotice(`Policy saved by ${result.data.updatedName}. Past suspensions keep the policy that was in force when they were raised.`); setReason(''); }
      else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    } catch { setError('The policy could not be saved. Nothing was changed.'); }
    finally { setBusy(false); }
  }

  if (loading) return <p className="table-state" role="status">Loading the service policy.</p>;

  return <>
    <div className="page-heading">
      <div><p className="eyebrow">SERVICE POLICY</p><h1>Disconnection policy</h1><p className="muted">How long the office waits before a service may be cut off, and what a reconnection costs. Changing the policy never rewrites a decision already taken.</p></div>
    </div>
    {error && <div className="form-alert" role="alert">{error}</div>}
    {notice && <div className="success-notice" role="status">{notice}</div>}

    <form className="panel billing-command" onSubmit={event => void save(event)}>
      <h3>Policy in force</h3>
      <div className="billing-command-fields">
        <label>Grace period (days)<input aria-label="Grace period days" type="number" min={0} max={365} required disabled={!canControl} value={grace} onChange={event => setGrace(event.target.value)} /></label>
        <label>Suspension threshold (centavos)<input aria-label="Suspension threshold" type="number" min={0} required disabled={!canControl} value={threshold} onChange={event => setThreshold(event.target.value)} /></label>
        <label>Reconnection fee (centavos)<input aria-label="Reconnection fee" type="number" min={0} required disabled={!canControl} value={fee} onChange={event => setFee(event.target.value)} /></label>
        <label className="checkbox-label"><input aria-label="Automatic suspension" type="checkbox" disabled={!canControl} checked={auto} onChange={event => setAuto(event.target.checked)}/>Suspend automatically once the policy is met</label>
        <label>Reason for the change<input aria-label="Policy change reason" required maxLength={500} disabled={!canControl} value={reason} onChange={event => setReason(event.target.value)} placeholder="Why the policy is changing" /></label>
      </div>
      {canControl && <div className="billing-command-actions">
        <button className="primary-button" type="submit" aria-label="Save service policy" disabled={busy || reason.trim().length < 3}>{busy ? 'Saving…' : 'Save policy'}</button>
      </div>}
      {policy && <p className="muted">Last changed by {policy.updatedName}. Amounts are stored in centavos, so no policy figure is ever a rounded peso.</p>}
      <p className="muted">Amounts are entered in centavos. {policy && `The reconnection fee is currently ${moneyLabel(policy.reconnectionFeeCentavos)}.`}</p>
    </form>

    <p className="info-note">Automatic suspension is a policy flag only. Even with it on, a disconnection is raised as a document with a reason and an approving user, and the database still refuses any change to a service status that was not made through those commands.</p>
  </>;
}
