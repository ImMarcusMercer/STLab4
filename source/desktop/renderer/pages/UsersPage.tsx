import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, Plus, RefreshCw, X } from 'lucide-react';
import { roleNames, type Actor, type RoleCode, type UserList, type ApiResult } from '../../../shared/auth';

type Props = { user: Actor; onUnauthorized(): void; onSessionRefresh(): Promise<void> };
export function UsersPage({ user, onUnauthorized, onSessionRefresh }: Props) {
  const [data, setData] = useState<UserList | null>(null);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<Actor | null | undefined>(undefined);
  useEffect(() => {
    let current = true; setLoading(true); setError('');
    void window.bcis.listUsers(page).then((result) => {
      if (!current) return;
      if (result.ok) setData(result.data);
      else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    }).catch(() => { if (current) setError('Unable to load user accounts.'); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [page, revision]);

  return <div className="users-page">
    <div className="page-heading"><div><p className="eyebrow">ADMINISTRATION</p><h1>User accounts</h1><p className="muted">Manage individual access, roles and account status.</p></div><button className="primary-button" onClick={() => setEditing(null)}><Plus size={16} />New user</button></div>
    {error && <div className="form-alert" role="alert">{error}</div>}
    {notice && <div className="success-notice" role="status">{notice}</div>}
    <section className="users-table-panel" aria-busy={loading}>
      <header><h2>{data?.total ?? '—'} accounts</h2><button className="refresh-button" onClick={() => setRevision((value) => value + 1)} disabled={loading}><RefreshCw size={14} />Refresh</button></header>
      {loading ? <p className="table-state" role="status">Loading user accounts…</p> : <div className="table-scroll"><table><thead><tr><th>Account</th><th>Username</th><th>Roles</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{data?.items.map((account) => <tr key={account.id}><td><strong>{account.displayName}</strong>{account.id === user.id && <small className="current-user">Your account</small>}</td><td>{account.username}</td><td>{account.roles.map((role) => roleNames[role]).join(', ')}</td><td><span className={`badge ${account.active ? 'good' : 'neutral'}`}>{account.active ? 'Active' : 'Inactive'}</span></td><td><button className="text-button" onClick={() => setEditing(account)} aria-label={`Edit ${account.username}`}>Edit</button></td></tr>)}</tbody></table>{data?.items.length === 0 && <p className="table-state">No user accounts found.</p>}</div>}
      <footer><span>Page {page} of {Math.max(1, Math.ceil((data?.total ?? 0) / 20))}</span><div><button className="icon-button" aria-label="Previous page" disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={17} /></button><button className="icon-button" aria-label="Next page" disabled={loading || page * 20 >= (data?.total ?? 0)} onClick={() => setPage((value) => value + 1)}><ChevronRight size={17} /></button></div></footer>
    </section><div className="info-note"><p>Account and role changes are audited. Deactivation, role changes and password resets end the affected user’s sessions. At least one active Owner must remain.</p></div>
    {editing !== undefined && <UserDialog account={editing} onClose={() => setEditing(undefined)} onUnauthorized={onUnauthorized} onSaved={async () => { setEditing(undefined); setNotice('Account saved.'); setRevision((value) => value + 1); await onSessionRefresh(); }} />}
  </div>;
}

function UserDialog({ account, onClose, onSaved, onUnauthorized }: { account: Actor | null; onClose(): void; onSaved(): Promise<void>; onUnauthorized(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [username, setUsername] = useState(account?.username ?? '');
  const [displayName, setDisplayName] = useState(account?.displayName ?? '');
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<RoleCode[]>(account?.roles ?? []);
  const [active, setActive] = useState(account?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string[]>>({});
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setFields({});
    try {
      let result: ApiResult<Actor>;
      if (account) {
        const changes = { ...(displayName !== account.displayName ? { displayName } : {}), ...(active !== account.active ? { active } : {}), ...(roles.slice().sort().join() !== account.roles.slice().sort().join() ? { roles } : {}), ...(password ? { password } : {}) };
        if (!Object.keys(changes).length) { onClose(); return; }
        result = await window.bcis.updateUser(account.id, changes);
      } else result = await window.bcis.createUser({ username, displayName, password, roles });
      if (result.ok) { setPassword(''); await onSaved(); }
      else { setError(result.error.message); setFields(result.error.fields ?? {}); if (result.error.status === 401) onUnauthorized(); }
    } catch { setError('The account could not be saved. Try again.'); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="account-dialog" aria-labelledby="account-dialog-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}><header><div><p className="eyebrow">ACCESS MANAGEMENT</p><h2 id="account-dialog-title">{account ? 'Edit account' : 'New user account'}</h2></div><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={19} /></button></header>
    {error && <div className="form-alert" role="alert">{error}</div>}
    <form className="account-form" onSubmit={(event) => void submit(event)}>
      <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required minLength={2} maxLength={100} autoFocus />{fields.displayName && <small className="field-error">{fields.displayName.join(' ')}</small>}</label>
      <label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} required minLength={3} maxLength={64} disabled={Boolean(account)} autoComplete="off" />{fields.username && <small className="field-error">{fields.username.join(' ')}</small>}</label>
      <label><span id="account-password-label">{account ? 'New password (optional)' : 'Password'}</span><input aria-labelledby="account-password-label" aria-describedby="account-password-help" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required={!account} minLength={12} maxLength={128} autoComplete="new-password" /><small id="account-password-help">{account ? 'Leave blank to keep the current password.' : 'At least 12 characters.'}</small>{fields.password && <small className="field-error">{fields.password.join(' ')}</small>}</label>
      <fieldset><legend>Roles <span className="muted">Choose at least one</span></legend><div className="role-grid">{(Object.keys(roleNames) as RoleCode[]).map((role) => <label key={role} className="checkbox-label"><input type="checkbox" checked={roles.includes(role)} onChange={(event) => setRoles((current) => event.target.checked ? [...current, role] : current.filter((value) => value !== role))} />{roleNames[role]}</label>)}</div>{fields.roles && <small className="field-error">{fields.roles.join(' ')}</small>}</fieldset>
      {account && <label className="checkbox-label"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />Account is active</label>}
      <footer><button type="button" className="refresh-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Saving…' : account ? 'Save changes' : 'Create account'}</button></footer>
    </form>
  </dialog>;
}
