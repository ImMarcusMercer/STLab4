import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ClipboardList, Plus, RefreshCw } from 'lucide-react';
import type { Actor } from '../../../shared/auth';
import { moneyLabel } from '../../../shared/collections';
import type { BatchList, BatchQueryInput, BatchStatus } from '../../../shared/collections';
import type { MasterList, MasterRecord } from '../../../shared/master-data';
import { CollectionBatchPanel } from './CollectionBatchPanel';
import { MasterPage } from './MasterPage';

const today = () => new Date().toISOString().slice(0, 10);
const statusTone = (status: BatchStatus) => status === 'RECONCILED' ? 'good' : status === 'CLOSED' ? 'neutral' : status === 'SUBMITTED' || status === 'REMITTED' ? 'warn' : 'blue';

/**
 * Collections is the day-to-day screen for the field: open a route for a collector and an
 * area, work the accounts on it, count the cash in, and sign the sheet off. The list is a
 * read of the server, and the numbers on every card come back with the command that set them.
 */
export function CollectionsPage({ user, onUnauthorized }: { user: Actor; onUnauthorized(): void }) {
  const [tab, setTab] = useState<'routes' | 'setup'>('routes');
  return <div className="collections-page">
    <div className="module-tabs" role="tablist" aria-label="Collections">
      <button role="tab" aria-selected={tab === 'routes'} onClick={() => setTab('routes')}>Collection routes</button>
      <button role="tab" aria-selected={tab === 'setup'} onClick={() => setTab('setup')}>Areas &amp; collectors</button>
    </div>
    {tab === 'routes'
      ? <RoutesTab user={user} onUnauthorized={onUnauthorized} />
      : <MasterPage user={user} initial="areas" onUnauthorized={onUnauthorized} />}
  </div>;
}

function RoutesTab({ user, onUnauthorized }: { user: Actor; onUnauthorized(): void }) {
  const [data, setData] = useState<BatchList | null>(null);
  const [query, setQuery] = useState(''); const [status, setStatus] = useState(''); const [page, setPage] = useState(1); const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false); const [busy, setBusy] = useState(false);
  const [areas, setAreas] = useState<MasterList<'areas'> | null>(null); const [collectors, setCollectors] = useState<MasterList<'collectors'> | null>(null);
  const [areaId, setAreaId] = useState(''); const [collectorId, setCollectorId] = useState(''); const [date, setDate] = useState(today()); const [notes, setNotes] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const canManage = user.permissions.includes('collection.manage');

  useEffect(() => {
    let current = true; setLoading(true); setError('');
    const timer = setTimeout(() => { void window.bcis.listCollectionBatches({ q: query, page, ...(status ? { status: status as BatchStatus } : {}) } as BatchQueryInput).then(result => {
      if (!current) return;
      if (result.ok) setData(result.data); else { setData(null); setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => { if (current) { setData(null); setError('Collection routes could not be loaded.'); } }).finally(() => { if (current) setLoading(false); }); },180);
    return () => { current = false; clearTimeout(timer); };
  },[query,status,page,revision]);

  /** The route form needs the active areas and collectors, and only asks for them when it opens. */
  useEffect(() => {
    if (!creating) return;
    let current = true;
    void Promise.all([window.bcis.listAreas({ q: '', page: 1, perPage: 100, status: 'ACTIVE' }), window.bcis.listCollectors({ q: '', page: 1, perPage: 100, status: 'ACTIVE' })]).then(([areaResult, collectorResult]) => {
      if (!current) return;
      if (areaResult.ok) setAreas(areaResult.data); else setError(areaResult.error.message);
      if (collectorResult.ok) setCollectors(collectorResult.data); else setError(collectorResult.error.message);
    }).catch(() => { if (current) setError('The areas and collectors could not be loaded.'); });
    return () => { current = false; };
  },[creating]);

  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const result = await window.bcis.createCollectionBatch({ areaId, collectorId, collectionDate: date, notes: notes.trim() });
      if (result.ok) { setSelected(result.data.id); setNotice(`Route ${result.data.batchNumber} opened with ${result.data.accountCount} account(s) from the area.`); setCreating(false); setNotes(''); setRevision(value => value + 1); }
      else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    } catch { setError('The route could not be opened. Nothing was saved.'); }
    finally { setBusy(false); }
  }

  const areaName = (id: string) => areas?.items.find((row: MasterRecord<'areas'>) => row.id === id)?.name ?? '';
  const collectorName = (id: string) => collectors?.items.find((row: MasterRecord<'collectors'>) => row.id === id)?.name ?? '';

  return <>
    <div className="page-heading">
      <div><p className="eyebrow">COLLECTIONS</p><h1>Collection routes</h1><p className="muted">A route freezes the accounts and the amounts due on the day it is opened, so the sheet the collector carries is the sheet the office reconciles.</p></div>
      {canManage && <button className="primary-button" aria-label="Open collection route" onClick={() => setCreating(value => !value)}><Plus size={16}/>Open route</button>}
    </div>
    {error && <div className="form-alert" role="alert">{error}</div>}
    {notice && <div className="success-notice" role="status">{notice}</div>}

    {creating && canManage && <form className="panel billing-command collection-create" onSubmit={event => void create(event)}>
      <h3>Open a route for one collector in one area</h3>
      <div className="billing-command-fields">
        <label>Area<select aria-label="Route area" required value={areaId} onChange={event => setAreaId(event.target.value)}><option value="">Select an area</option>{areas?.items.map((row: MasterRecord<'areas'>) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        <label>Collector<select aria-label="Route collector" required value={collectorId} onChange={event => setCollectorId(event.target.value)}><option value="">Select a collector</option>{collectors?.items.map((row: MasterRecord<'collectors'>) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        <label>Collection date<input aria-label="Collection date" type="date" required max={today()} value={date} onChange={event => setDate(event.target.value)} /></label>
        <label>Notes<input aria-label="Route notes" value={notes} onChange={event => setNotes(event.target.value)} maxLength={500} placeholder="Optional" /></label>
      </div>
      <div className="billing-command-actions">
        <button className="primary-button" type="submit" aria-label="Create collection route" disabled={busy || !areaId || !collectorId}>{busy ? 'Opening…' : 'Open route'}</button>
        <button className="text-button" type="button" aria-label="Cancel opening route" onClick={() => setCreating(false)}>Cancel</button>
      </div>
      <p className="muted">Only accounts with an open balance in the chosen area are added, and one collector may hold only one open route for an area on a day. An area with nothing due is refused rather than sent out empty.</p>
    </form>}

    <div className="master-toolbar">
      <input aria-label="Search collection routes" placeholder="Batch number, collector or area." value={query} onChange={event => { setQuery(event.target.value); setPage(1); }}/>
      <select aria-label="Filter route status" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option>{['OPEN','IN_PROGRESS','SUBMITTED','REMITTED','RECONCILED','CLOSED'].map(value => <option key={value} value={value}>{value.replace('_',' ')}</option>)}</select>
      <button className="refresh-button" aria-label="Refresh collection routes" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14}/>Refresh</button>
    </div>

    {loading ? <p className="table-state" role="status">Loading collection routes.</p> : <div className="table-scroll">
      <table><thead><tr><th>Batch</th><th>Date</th><th>Collector</th><th>Area</th><th>Expected</th><th>Collected</th><th>Uncollected</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        {data?.items.map(row => <tr key={row.id} className={row.id === selected ? 'row-selected' : ''}>
          <td><strong>{row.batchNumber}</strong></td><td>{row.collectionDate}</td>
          <td>{areaName(row.areaId) || row.areaName}</td><td>{collectorName(row.collectorId) || row.collectorName}</td>
          <td className="money-cell">{moneyLabel(row.expectedReceivableCentavos)}</td>
          <td className="money-cell">{moneyLabel(row.totalCollectedCentavos)}</td>
          <td className="money-cell">{moneyLabel(row.uncollectedCentavos)}</td>
          <td><span className={`badge ${statusTone(row.status)}`}>{row.status.replace('_',' ')}</span></td>
          <td><div className="row-actions">
            <button className="text-button" aria-label={`Open ${row.batchNumber}`} onClick={() => setSelected(row.id)}><ClipboardList size={14}/>Open</button>
          </div></td>
        </tr>)}
      </tbody></table>
      {data?.items.length === 0 && <p className="table-state">No collection routes match. Open a route to start a collector&rsquo;s day.</p>}
    </div>}

    {data && data.total > 0 && <div className="pager">
      <span className="muted">Page {data.page} of {Math.max(1, Math.ceil(data.total / data.perPage))} · {data.total} route(s)</span>
      <div className="row-actions">
        <button className="refresh-button" aria-label="Previous page of routes" disabled={page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={14}/></button>
        <button className="refresh-button" aria-label="Next page of routes" disabled={page * data.perPage >= data.total} onClick={() => setPage(value => value + 1)}><ChevronRight size={14}/></button>
      </div>
    </div>}

    {selected && <CollectionBatchPanel batchId={selected} user={user} onUnauthorized={onUnauthorized} onChanged={() => setRevision(value => value + 1)} />}

    <p className="info-note">Collections are counted by the collector and signed off by someone else, so a shortage or an overage stays on the record until it has been explained. Nothing on a route is ever deleted or rebalanced silently.</p>
  </>;
}
