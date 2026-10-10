import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, Download, Printer, RefreshCw, ShieldCheck } from 'lucide-react';
import type { Actor } from '../../../shared/auth';
import { agingBucketLabels } from '../../../shared/receivables';
import {
  defaultGranularity, formatCell, formatMoneyCell, reportCatalogue,
  type Dashboard, type Dimension, type ExportFormat, type Granularity, type ReportCode, type ReportTable,
} from '../../../shared/reports';

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

/**
 * The management view: a dashboard for "how is the office doing" and a report browser for
 * "show me the detail behind that".
 *
 * Two rules run through this screen.
 *
 * 1. The renderer never computes a figure. Every peso, count, bucket and total on this page
 *    arrived from the API as an integer number of centavos already reconciled against its own
 *    rows. The only formatting here turns those integers into text. A dashboard that added up
 *    its own tiles would be able to disagree with the report it links to.
 * 2. An export is the server's document, not the screen's. `exportReport` returns only whether
 *    a file was saved; the bytes were written by the main process through the native dialog,
 *    so no renderer code can read, name or place a file.
 */
export function ReportsPage({ user, onUnauthorized, initialTab = 'dashboard' }: {
  user: Actor; onUnauthorized(): void; initialTab?: 'dashboard' | 'reports';
}) {
  const canExport = user.permissions.includes('report.export');
  const [tab, setTab] = useState<'dashboard' | 'reports'>(user.permissions.includes('dashboard.view') ? initialTab : 'reports');
  return <div className="reports-page">
    <div className="module-tabs" role="tablist" aria-label="Reports">
      {user.permissions.includes('dashboard.view') && <button role="tab" aria-selected={tab === 'dashboard'} onClick={() => setTab('dashboard')}>Dashboard</button>}
      <button role="tab" aria-selected={tab === 'reports'} onClick={() => setTab('reports')}>Reports</button>
    </div>
    {/* The dashboard is a reading of the reports rather than a tenth report, so it has no
        export of its own: printing it uses the browser, and the figures it shows are each
        reachable from a named report that can be exported. */}
    {tab === 'dashboard'
      ? <DashboardTab onUnauthorized={onUnauthorized} />
      : <ReportTab onUnauthorized={onUnauthorized} canExport={canExport} />}
  </div>;
}

// ---------------------------------------------------------------------------- dashboard

function DashboardTab({ onUnauthorized }: { onUnauthorized(): void }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [asOf, setAsOf] = useState(today());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true); setError('');
    void window.bcis.getDashboard({ to: asOf }).then(result => {
      if (result.ok) setData(result.data);
      else { setData(null); setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => setError('The dashboard could not be loaded. Check the connection and try again.'))
      .finally(() => setLoading(false));
  }, [asOf, onUnauthorized]);
  useEffect(() => { load(); }, [load]);

  // The widest month on screen, so the bars share one scale. Drawn from figures the server
  // sent; the longest bar is simply whichever month collected the most. This is a length for
  // drawing only and is never shown as a peso figure.
  const peak = useMemo(() => Math.max(1, ...(data?.billingVsCollection ?? []).map(entry => entry.collectedCentavos)), [data]);
  const collectedThisMonth = data?.kpis.find(kpi => kpi.key === 'collected')?.valueCentavos ?? 0;

  return <>
    <div className="page-heading">
      <div>
        <p className="eyebrow">MANAGEMENT DASHBOARD</p>
        <h1>How the office is doing</h1>
        <p className="muted">Review key figures, monthly trends and accounts that need follow-up.</p>
      </div>
    </div>
    {error && <div className="form-alert" role="alert">{error}</div>}

    <div className="master-toolbar">
      <label className="inline-field"><CalendarDays size={15} /><span>As of</span>
        <input aria-label="Dashboard date" type="date" max={today()} value={asOf} onChange={event => setAsOf(event.target.value)} />
      </label>
      <button className="refresh-button" aria-label="Refresh dashboard" disabled={loading} onClick={load}><RefreshCw size={14} className={loading ? 'spinning' : ''} />Refresh</button>
      <button className="refresh-button" aria-label="Print dashboard" disabled={!data} onClick={() => window.print()}><Printer size={14} />Print</button>
    </div>

    {loading && !data ? <p className="table-state" role="status">Loading the dashboard.</p> : data && <>
      <p className="muted print-only">BCIS dashboard as of {data.asOf}, produced {new Date(data.generatedAt).toLocaleString()}.</p>

      <div className="kpi-row">
        {data.kpis.map(kpi => <div key={kpi.key} className={`kpi-card tone-${kpi.tone}`}>
          <span className="kpi-label">{kpi.label}</span>
          <strong className="money-cell">{formatMoneyCell(kpi.valueCentavos)}</strong>
          {/* The count travels with the figure so the two can never be read as separate claims. */}
          <small>{kpi.count > 0 ? `${kpi.count.toLocaleString('en-GB')} · ` : ''}{kpi.hint}</small>
        </div>)}
      </div>

      <div className="report-split">
        <section className="panel">
          <div className="panel-top"><h3>Billing against collection</h3><span className="subtle-label">{data.monthLabel}</span></div>
          <div className="trend-chart" role="img" aria-label={`Collection trend to ${data.asOf}. Peak ${formatMoneyCell(peak)}.`}>
            {data.billingVsCollection.map(entry => <div key={entry.period} className="trend-row">
              <span className="trend-label">{entry.label}</span>
              <div className="trend-bars">
                <span className="trend-bar billed" style={{ width: `${Math.round((entry.billedCentavos / peak) * 100)}%` }} title={`Billed ${formatMoneyCell(entry.billedCentavos)}`} />
                <span className="trend-bar collected" style={{ width: `${Math.round((entry.collectedCentavos / peak) * 100)}%` }} title={`Collected ${formatMoneyCell(entry.collectedCentavos)}`} />
              </div>
              <span className="money-cell trend-value">{formatMoneyCell(entry.collectedCentavos, false)}</span>
            </div>)}
            {data.billingVsCollection.length === 0 && <p className="table-state">Nothing has been billed in this period yet.</p>}
          </div>
          <div className="chart-key"><span><i className="swatch billed" />Billed</span><span><i className="swatch collected" />Collected</span></div>
          <p className="muted">{formatMoneyCell(collectedThisMonth)} collected against {formatMoneyCell(data.kpis.find(kpi => kpi.key === 'billed')?.valueCentavos ?? 0)} billed this month.</p>
        </section>

        <section className="panel">
          <div className="panel-top"><h3>Accounts receivable aging</h3><span className="subtle-label">{formatMoneyCell(data.receivableTotalCentavos)}</span></div>
          <div className="aging-strip">
            {data.aging.map(entry => <div key={entry.bucket} className={`aging-cell ${entry.bucket === 'CURRENT' ? 'good' : entry.bucket === 'D90_PLUS' ? 'danger' : entry.bucket === 'D61_90' ? 'warn' : 'blue'}`}>
              <span>{entry.label || agingBucketLabels[entry.bucket]}</span>
              <strong className="money-cell">{formatMoneyCell(entry.totalCentavos)}</strong>
              {/* Count and money together: the aging is about accounts, not just a peso total. */}
              <small>{entry.accountCount} account(s) · {entry.invoiceCount} invoice(s)</small>
            </div>)}
          </div>
          {data.paymentMethods.length > 0 && <>
            <h4 className="sub-heading">How it was paid</h4>
            <ul className="method-list">{data.paymentMethods.map(entry => <li key={entry.method}>
              <span>{entry.method}</span><small>{entry.receipts} receipt(s)</small><strong className="money-cell">{formatMoneyCell(entry.collectedCentavos)}</strong>
            </li>)}</ul>
          </>}
        </section>
      </div>

      <section className="panel">
        <div className="panel-top"><h3>Needs attention today</h3><span className="subtle-label">{data.overdueAlerts.length} account(s)</span></div>
        {data.overdueAlerts.length === 0 ? <p className="table-state">Nothing is past due beyond the policy threshold.</p> : <div className="table-scroll">
          <table><thead><tr><th>Account</th><th>Plan</th><th>Area / collector</th><th>Arrears</th><th>Oldest</th></tr></thead><tbody>
            {data.overdueAlerts.map(row => <tr key={row.serviceAccountId}>
              <td><strong>{row.subscriberName}</strong><small>{row.subscriberCode}</small></td>
              <td>{row.planName}</td>
              <td>{row.areaName || '—'}<small>{row.collectorName || 'Unassigned'}</small></td>
              <td className="money-cell">{formatMoneyCell(row.arrearsCentavos)}<small><span className={`badge ${row.bucket === 'D90_PLUS' ? 'danger' : 'warn'}`}>{row.overdueDays} day(s) late</span></small></td>
              <td>{agingBucketLabels[row.bucket]}</td>
            </tr>)}
          </tbody></table>
        </div>}
      </section>

      <div className="report-split">
        <section className="panel">
          <h3>Collector performance</h3>
          {data.collectors.length === 0 ? <p className="table-state">No collectors have open routes.</p> : <div className="table-scroll"><table>
            <thead><tr><th>Collector</th><th>Accounts</th><th>Expected</th><th>Collected</th><th>Remitted</th><th>Variance</th></tr></thead><tbody>
              {data.collectors.map(row => <tr key={row.collectorCode}>
                <td><strong>{row.collectorName}</strong><small>{row.collectorCode}</small></td>
                <td>{row.accounts}</td>
                <td className="money-cell">{formatMoneyCell(row.expectedCashCentavos)}</td>
                <td className="money-cell">{formatMoneyCell(row.collectedCashCentavos)}</td>
                <td className="money-cell">{formatMoneyCell(row.remittedCentavos)}</td>
                {/* A shortage and an overage are the same number with a sign, shown as words. */}
                <td className="money-cell">{formatMoneyCell(row.varianceCentavos)}<small>{row.varianceCentavos === 0 ? 'Balanced' : row.varianceCentavos < 0 ? 'Shortage' : 'Overage'}</small></td>
              </tr>)}
            </tbody></table></div>}
        </section>

        <section className="panel">
          <h3>Latest receipts</h3>
          {data.recentPayments.length === 0 ? <p className="table-state">No payments recorded.</p> : <ul className="receipt-list">
            {data.recentPayments.map(row => <li key={row.id}>
              <span><strong>{row.receiptNumber ?? 'Not yet numbered'}</strong><small>{row.subscriberName} · {row.recordedName}</small></span>
              <span className="money-cell">{formatMoneyCell(row.amountCentavos)}<small>{row.method} · {row.status}</small></span>
            </li>)}
          </ul>}
        </section>
      </div>

      <p className="info-note">Figures reflect posted invoices, payments and remittances as of the selected date.</p>
    </>}
  </>;
}

// ------------------------------------------------------------------------------- reports

const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: 'DAY', label: 'Daily' }, { value: 'WEEK', label: 'Weekly' }, { value: 'MONTH', label: 'Monthly' }, { value: 'YEAR', label: 'Yearly' },
];

function ReportTab({ onUnauthorized, canExport }: { onUnauthorized(): void; canExport: boolean }) {
  const [code, setCode] = useState<ReportCode>('COLLECTIONS');
  const [from, setFrom] = useState(monthStart(today()));
  const [to, setTo] = useState(today());
  const [granularity, setGranularity] = useState<Granularity>(() => defaultGranularity(monthStart(today()), today()));
  const [dimension, setDimension] = useState<Dimension>('PLAN');
  const [subscriberId, setSubscriberId] = useState('');
  const [subscribers, setSubscribers] = useState<{ id: string; code: string; name: string }[]>([]);
  const [table, setTable] = useState<ReportTable | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState<ExportFormat | null>(null);

  const definition = reportCatalogue[code];

  useEffect(() => {
    if (!definition.requiresSubscriber) return;
    // The statement is per subscriber, so the choices come from the server's own list rather
    // than a free-text id that would only fail on submit.
    void window.bcis.listSubscribers({ q: '', page: 1, perPage: 100, status: 'ACTIVE' }).then(result => {
      if (!result.ok) return;
      setSubscribers(result.data.items.map(row => ({ id: row.id, code: row.code, name: row.name })));
    }).catch(() => setError('The subscriber list could not be loaded.'));
  }, [definition.requiresSubscriber]);

  const filters = useMemo(() => ({
    from, to,
    ...(definition.granularity ? { granularity } : {}),
    ...(definition.dimension.length > 0 ? { dimension } : {}),
    ...(definition.requiresSubscriber && subscriberId ? { subscriberId } : {}),
  }), [from, to, granularity, dimension, definition, subscriberId]);

  const load = useCallback(() => {
    setLoading(true); setError(''); setNotice('');
    void window.bcis.getReport(code, filters).then(result => {
      if (result.ok) setTable(result.data);
      else { setTable(null); setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => setError('The report could not be loaded. Check the connection and try again.'))
      .finally(() => setLoading(false));
  }, [code, filters, onUnauthorized]);
  useEffect(() => { load(); }, [load]);

  async function save(format: ExportFormat) {
    setSaving(format); setError(''); setNotice('');
    try {
      const result = await window.bcis.exportReport(code, filters, format);
      if (!result.ok) setError(result.error.message);
      // A cancelled dialog is not a failure, so it gets a plain sentence rather than an alert.
      else if (result.data.saved) setNotice(`${result.data.fileName} was saved.`);
      else setNotice('The save was cancelled. Nothing was written.');
    } catch { setError('The export could not be produced. Nothing was saved.'); }
    finally { setSaving(null); }
  }

  return <>
    <div className="page-heading">
      <div>
        <p className="eyebrow">MANAGEMENT REPORTS</p>
        <h1>{definition.title}</h1>
        <p className="muted">{definition.description}</p>
      </div>
    </div>
    {error && <div className="form-alert" role="alert">{error}</div>}
    {notice && <div className="success-notice" role="status">{notice}</div>}

    <div className="report-picker" role="radiogroup" aria-label="Choose a report">
      {(Object.keys(reportCatalogue) as ReportCode[]).map(key => <button key={key} role="radio" aria-checked={key === code} className={key === code ? 'active' : ''} onClick={() => {
        setCode(key);
        // A snapshot report answers one day, so it is not offered a range it cannot honour.
        if (reportCatalogue[key].snapshot) setFrom(today());
      }}>{reportCatalogue[key].title}</button>)}
    </div>

    <div className="master-toolbar">
      {!definition.snapshot && <label className="inline-field"><span>From</span><input aria-label="Report start date" type="date" max={to} value={from} onChange={event => setFrom(event.target.value)} /></label>}
      <label className="inline-field"><span>{definition.snapshot ? 'As of' : 'To'}</span><input aria-label="Report end date" type="date" min={definition.snapshot ? undefined : from} max={today()} value={to} onChange={event => setTo(event.target.value)} /></label>
      {definition.granularity && <select aria-label="Group by period" value={granularity} onChange={event => setGranularity(event.target.value as Granularity)}>
        {GRANULARITIES.map(entry => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
      </select>}
      {definition.dimension.length > 0 && <select aria-label="Group revenue by" value={dimension} onChange={event => setDimension(event.target.value as Dimension)}>
        {definition.dimension.map(entry => <option key={entry} value={entry}>{entry.replace(/_/g, ' ').toLowerCase()}</option>)}
      </select>}
      {definition.requiresSubscriber && <select aria-label="Subscriber" value={subscriberId} onChange={event => setSubscriberId(event.target.value)}>
        <option value="">Choose a subscriber</option>
        {subscribers.map(row => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}
      </select>}
      <button className="refresh-button" aria-label="Run report" disabled={loading || (definition.requiresSubscriber && !subscriberId)} onClick={load}><RefreshCw size={14} className={loading ? 'spinning' : ''} />Run report</button>
      <button className="refresh-button" aria-label="Print report" disabled={!table} onClick={() => window.print()}><Printer size={14} />Print</button>
    </div>

    {/* Export is offered only where the API said this user may export, so the button is not a
        promise the server would refuse. The files are built server-side either way. */}
    {canExport && <div className="export-row">
      <span className="subtle-label">EXPORT</span>
      {(['PDF', 'XLSX', 'CSV'] as ExportFormat[]).map(format => <button key={format} className="refresh-button" aria-label={`Save as ${format}`} disabled={saving !== null || (definition.requiresSubscriber && !subscriberId)} onClick={() => void save(format)}>
        <Download size={14} />{saving === format ? 'Preparing…' : format}
      </button>)}
      <span className="muted">Save the current report in your preferred format.</span>
    </div>}

    {definition.snapshot && <p className="muted">This report is a snapshot of one day. It answers &ldquo;what is owed on {to}&rdquo; and cannot be asked for a range.</p>}
    {definition.requiresSubscriber && !subscriberId && <p className="table-state">Choose a subscriber to produce their statement of account.</p>}

    {table && <>
      {table.truncated && <div className="form-alert" role="alert"><AlertTriangle size={16} />This export was bounded at {table.rowCount} rows. Narrow the date range for a complete file.</div>}
      <div className="report-meta">
        <span>{table.periodLabel}</span>
        <span>{table.rowCount} row(s)</span>
        {/* Stated on the page, so a reader can see the proof rather than take the total on trust. */}
        <span>Produced {new Date(table.generatedAt).toLocaleString()} by {table.generatedBy}</span>
      </div>

      <div className="table-scroll">
        <table className="report-table">
          <thead><tr>{table.columns.map(column => <th key={column.key} style={{ textAlign: column.align === 'LEFT' ? 'left' : 'right' }}>{column.label}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, index) => <tr key={index}>
            {table.columns.map(column => <td key={column.key} className={column.kind === 'MONEY' ? 'money-cell' : ''} style={{ textAlign: column.align === 'LEFT' ? 'left' : 'right' }}>{formatCell(row[column.key] ?? null, column)}</td>)}
          </tr>)}</tbody>
          {table.totals.map((total, index) => <tfoot key={index}><tr className={total.emphasis ? 'total-emphasis' : ''}>
            {table.columns.map((column, position) => <td key={column.key} className={column.kind === 'MONEY' ? 'money-cell' : ''} style={{ textAlign: column.align === 'LEFT' ? 'left' : 'right' }}>
              {position === 0 ? total.label : total.values[column.key] === undefined || total.values[column.key] === null ? '' : formatCell(total.values[column.key]!, column)}
            </td>)}
          </tr></tfoot>)}
        </table>
        {table.rows.length === 0 && <p className="table-state">No rows matched this period.</p>}
      </div>

      {table.reconciliations.length > 0 && <div className="reconciliation" role="note">
        <ShieldCheck size={15} />
        <span><strong>Totals checked:</strong> {table.reconciliations.map(entry => `${entry.label} — rows ${formatMoneyCell(entry.summedCentavos, false)} against the stated ${formatMoneyCell(entry.statedCentavos, false)}`).join('; ')}.</span>
      </div>}
      {table.footnote && <p className="muted">{table.footnote}</p>}
    </>}
  </>;
}

