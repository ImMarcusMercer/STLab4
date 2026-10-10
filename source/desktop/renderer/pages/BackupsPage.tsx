import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, HardDriveDownload, RefreshCw, RotateCcw, X } from 'lucide-react';
import type { Actor } from '../../../shared/auth';
import type { BackupRecord, BackupVerification, RestoreReport } from '../../../shared/backups';

type Props = { user: Actor; onUnauthorized(): void };

/** A file size the way an operator reads one, rather than a raw byte count. */
const readableSize = (bytes: number) => {
  if (bytes <= 0) return '—';
  const units = ['bytes', 'KB', 'MB', 'GB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
};

const when = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');

/**
 * The backup screen.
 *
 * Everything here is a question asked of the API and an answer displayed. The screen never writes
 * a file, never names a path to read and never decides whether a backup succeeded: a backup only
 * appears as complete once the server has written the archive and read it back with pg_restore, and
 * the row counts a restore is checked against come from the server too.
 *
 * The restore controls are the part worth reading twice. A restore replaces every posted figure in
 * the system, so it needs the confirmation word typed in full and a reason, and the report it
 * returns is shown as the server wrote it, including any table whose count did not come back to
 * what the backup recorded.
 */
export function BackupsPage({ user, onUnauthorized }: Props) {
  const [backups, setBackups] = useState<BackupRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [kind, setKind] = useState<'FULL' | 'DATABASE'>('FULL');
  const [note, setNote] = useState('');
  const [restoring, setRestoring] = useState<BackupRecord | null>(null);
  const [checks, setChecks] = useState<Record<string, BackupVerification>>({});
  const [report, setReport] = useState<{ backup: BackupRecord; result: RestoreReport } | null>(null);

  const mayCreate = user.permissions.includes('backup.create');
  const mayVerify = user.permissions.includes('backup.verify');
  const mayRestore = user.permissions.includes('backup.restore');

  const load = (clearError = true) => {
    setLoading(true); if (clearError) setError('');
    void window.bcis.listBackups().then((result) => {
      if (result.ok) setBackups(result.data.backups);
      else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => setError('Unable to load the backup history.')).finally(() => setLoading(false));
  };
  useEffect(load, []);

  async function takeBackup() {
    setBusy(true); setError(''); setNotice(''); setReport(null);
    try {
      const result = await window.bcis.createBackup({ kind, note: note.trim() });
      if (result.ok) {
        setNote('');
        setNotice(`Backup complete (${readableSize(result.data.byteSize)}).`);
        load();
      } else {
        setError(result.error.message);
        if (result.error.status === 401) onUnauthorized();
        else load(false);
      }
    } catch { setError('The backup request could not be completed. Check the connection and try again.'); }
    finally { setBusy(false); }
  }

  async function verify(record: BackupRecord) {
    setError(''); setVerifyingId(record.id);
    try {
      const result = await window.bcis.verifyBackup(record.id);
      if (result.ok) setChecks((current) => ({ ...current, [record.id]: result.data }));
      else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    } catch { setError('The backup could not be verified. Check the connection and try again.'); }
    finally { setVerifyingId(null); }
  }

  return <div className="backups-page">
    <div className="page-heading">
      <div><p className="eyebrow">BUSINESS CONTINUITY</p><h1>Backup and restore</h1><p className="muted">Take a verified backup of the database and the payment proofs, and restore one when it is needed.</p></div>
      {mayCreate && <button className="primary-button" onClick={() => void takeBackup()} disabled={busy}><HardDriveDownload size={16} />{busy ? 'Backing up…' : 'Take backup'}</button>}
    </div>
    {error && <div className="form-alert" role="alert">{error}</div>}
    {notice && <div className="success-notice" role="status">{notice}</div>}

    {mayCreate && <section className="panel backup-request">
      <h3>What to include</h3>
      <p>Choose a full backup to protect office records and GCash payment proofs together. Use database only when you do not need those attachments.</p>
      <div className="backup-options">
        <label className="checkbox-label"><input type="radio" name="backup-kind" checked={kind === 'FULL'} onChange={() => setKind('FULL')} disabled={busy} />Full — database and payment proofs</label>
        <label className="checkbox-label"><input type="radio" name="backup-kind" checked={kind === 'DATABASE'} onChange={() => setKind('DATABASE')} disabled={busy} />Database only — without payment proofs</label>
      </div>
      <label className="backup-note">Note for the history<input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} placeholder="Before the October reconciliation" disabled={busy} /></label>
      <div className="panel-note">You can verify a completed backup from the history below.</div>
    </section>}

    {report && <RestoreReportPanel report={report} onClose={() => setReport(null)} />}

    <section className="users-table-panel" aria-busy={loading}>
      <header>
        <h2>{backups ? `${backups.length} backups on record` : 'Backup history'}</h2>
        <button className="refresh-button" onClick={() => load()} disabled={loading}><RefreshCw size={14} />Refresh</button>
      </header>
      {loading
        ? <p className="table-state" role="status">Loading the backup history…</p>
        : <div className="table-scroll"><table>
          <thead><tr><th>Taken</th><th>Contents</th><th>Size</th><th>Status</th><th>Checks</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{backups?.map((record) => {
            const check = checks[record.id];
            return <tr key={record.id}>
              <td><strong>{when(record.createdAt)}</strong>{record.note && <small className="current-user">{record.note}</small>}</td>
              <td>{record.kind === 'FULL' ? `Full${record.attachmentCount ? ` · ${record.attachmentCount} proof${record.attachmentCount === 1 ? '' : 's'}` : ''}` : 'Database only'}</td>
              <td>{readableSize(record.byteSize)}</td>
              <td>{record.status === 'COMPLETED'
                ? <span className="badge good">Complete</span>
                : <span className="badge warn" title={record.failureReason}>Failed</span>}</td>
              <td>
                {record.status !== 'COMPLETED'
                  ? <small>{record.failureReason}</small>
                  : check
                    ? <span className={`badge ${check.digestMatched && check.readable ? 'good' : 'warn'}`}>{check.digestMatched && check.readable ? 'Verified' : 'Damaged'}</span>
                    : <small>{record.verifiedAt ? `Read back ${when(record.verifiedAt)}` : 'Not verified'}{record.restoredAt && ` · restored ${when(record.restoredAt)}`}</small>}
              </td>
              <td>
                {record.status === 'COMPLETED' && <>
                  {mayVerify && <button className="text-button" disabled={verifyingId !== null} onClick={() => void verify(record)} aria-label={`Verify the backup of ${when(record.createdAt)}`}>{verifyingId === record.id ? 'Verifying…' : 'Verify'}</button>}
                  {mayRestore && <button className="text-button danger" onClick={() => setRestoring(record)} aria-label={`Restore the backup of ${when(record.createdAt)}`}><RotateCcw size={13} />Restore</button>}
                </>}
              </td>
            </tr>;
          })}</tbody>
        </table>{backups?.length === 0 && <p className="table-state">No backups have been taken yet.</p>}</div>}
    </section>
    <div className="info-note">
      <p>Verify backups regularly. After a restore, review the results to confirm that records and payment proofs were recovered.</p>
    </div>
    {restoring && <RestoreDialog backup={restoring} onClose={() => setRestoring(null)} onUnauthorized={onUnauthorized}
      onRestored={(result) => { setRestoring(null); setReport({ backup: restoring, result }); load(); }} />}
  </div>;
}

/**
 * The restore report, shown as the server wrote it.
 *
 * The counts are listed rather than summarised into a verdict, because the whole value of a restore
 * is whether the numbers came back: a table that differs is named, with what the backup recorded and
 * what is there now.
 */
function RestoreReportPanel({ report, onClose }: { report: { backup: BackupRecord; result: RestoreReport }; onClose(): void }) {
  const { result } = report;
  return <section className={`panel backup-report ${result.rowCountsMatched ? '' : 'attention'}`} aria-live="polite">
    <div className="panel-top"><span className={`badge ${result.rowCountsMatched ? 'good' : 'warn'}`}>{result.rowCountsMatched ? 'Counts matched' : 'Counts differ'}</span></div>
    <h3>Restore of {when(report.backup.createdAt)} finished at {when(result.restoredAt)}</h3>
    <p>The backup file passed its integrity check{result.attachmentsRestored ? `, and ${result.attachmentsRestored} payment proof${result.attachmentsRestored === 1 ? '' : 's'} were restored` : ''}.</p>
    {result.differences.length > 0 && <table className="report-differences"><thead><tr><th>Table</th><th>In the backup</th><th>After the restore</th></tr></thead><tbody>{result.differences.map((difference) => <tr key={difference.table}><td>{difference.table}</td><td>{difference.expected}</td><td>{difference.actual}</td></tr>)}</tbody></table>}
    <div className="panel-note">The reason for this restore was recorded.</div>
    <footer><button className="refresh-button" onClick={onClose}>Dismiss</button></footer>
  </section>;
}

/**
 * The confirmation an operator has to mean.
 *
 * The word has to be typed in full and a reason has to be given, because both end up in the audit
 * trail next to a restore that replaced every posted figure in the system. Nothing is sent until both
 * are right, so a stray double-click cannot begin one.
 */
function RestoreDialog({ backup, onClose, onRestored, onUnauthorized }: {
  backup: BackupRecord;
  onClose(): void;
  onRestored(result: RestoreReport): void;
  onUnauthorized(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirm, setConfirm] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = confirm === 'RESTORE' && reason.trim().length >= 3;
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    // The word is checked here as well as by the API. The button is disabled until it matches, and
    // this narrows the string to the literal so the typed contract is the server's, not a guess.
    if (confirm !== 'RESTORE' || reason.trim().length < 3) { setError('Type RESTORE and give a reason before restoring.'); return; }
    setBusy(true); setError('');
    try {
      const result = await window.bcis.restoreBackup(backup.id, { confirm, reason: reason.trim() });
      if (result.ok) onRestored(result.data);
      else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    } catch { setError('The restore request could not be completed. Check the connection and try again.'); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialog} className="account-dialog" aria-labelledby="restore-dialog-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><div><p className="eyebrow">DESTRUCTIVE ACTION</p><h2 id="restore-dialog-title">Restore the backup of {when(backup.createdAt)}</h2></div><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={19} /></button></header>
    {error && <div className="form-alert" role="alert">{error}</div>}
    <div className="restore-warning"><AlertTriangle size={18} /><p>Everything entered since this backup was taken will be replaced, including payments that have already been
      posted and any receipt numbers that have been issued. This cannot be undone from here, and the reason you give is recorded in the audit trail.</p></div>
    <form className="account-form" onSubmit={(event) => void submit(event)}>
      <label>Reason for this restore<textarea value={reason} onChange={(event) => setReason(event.target.value)} required minLength={3} maxLength={400} rows={2} autoFocus /></label>
      <label>Type RESTORE to confirm<input value={confirm} onChange={(event) => setConfirm(event.target.value)} required autoComplete="off" spellCheck={false} /></label>
      <footer><button type="button" className="refresh-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !ready}>{busy ? 'Restoring…' : 'Restore now'}</button></footer>
    </form>
  </dialog>;
}
