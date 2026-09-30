import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, LockKeyhole, RefreshCw, ShieldCheck, Wifi } from 'lucide-react';
import type { Actor } from '../../../shared/auth';
import type { ConnectionResult } from '../../../shared/contracts';

export function LoginPage({ lockedUser, notice, onSwitch, onSignedIn }: { lockedUser: Actor | null; notice: string; onSwitch(): void; onSignedIn(user: Actor): void }) {
  const [username, setUsername] = useState(lockedUser?.username ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState<ConnectionResult | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => { setUsername(lockedUser?.username ?? ''); setPassword(''); setError(''); }, [lockedUser]);
  async function refresh() {
    setChecking(true);
    try { setConnection(await window.bcis.getSystemStatus()); }
    catch { setConnection({ kind: 'unavailable', message: 'Check that the server is running, then refresh the connection.' }); }
    finally { setChecking(false); }
  }
  useEffect(() => { void refresh(); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await window.bcis.login({ username, password });
      if (result.ok) { setPassword(''); onSignedIn(result.data); }
      else setError(result.error.message);
    } catch { setError('Sign-in could not be completed. Please try again.'); }
    finally { setBusy(false); }
  }
  const connected = connection?.kind === 'status';
  const ready = connected && connection.data.status === 'ready';
  const status = checking || !connection ? 'Checking connection' : ready ? 'All systems connected' : connected ? 'Database needs attention' : 'API unavailable';

  return <div className="login-shell">
    <aside className="login-intro"><div className="brand"><span className="brand-mark"><Wifi size={25} /></span><div><strong>BCIS</strong><span>Billing & collections</span></div></div>
      <div className="login-intro-copy"><p className="eyebrow">BUKIDNON CABLE & INTERNET SERVICES</p><h2>One workspace.<br />Connected operations.</h2><p>Manage your team’s access to the billing and collection workspace.</p><div className="login-promise"><ShieldCheck size={22} /><span>Individual accounts.<br />Permissions enforced by the server.</span></div></div><span className="login-intro-footer">BCIS Subscription Billing and Collection System</span></aside>
    <main className="login-main"><div className="login-card"><span className="panel-symbol"><LockKeyhole size={22} /></span><p className="eyebrow">{lockedUser ? 'SESSION LOCK' : 'WELCOME BACK'}</p><h1>{lockedUser ? 'Workspace locked' : 'Sign in to BCIS'}</h1><p className="muted">{lockedUser ? `Enter your password to continue as ${lockedUser.displayName}.` : 'Use your individual office account to continue.'}</p>
      {(error || notice) && <div className="form-alert" role="alert">{error || notice}</div>}
      <form onSubmit={(event) => void submit(event)} className="account-form">
        <label>Username<input name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required maxLength={64} readOnly={Boolean(lockedUser)} autoFocus={!lockedUser} /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required maxLength={128} autoFocus={Boolean(lockedUser)} /></label>
        <button className="primary-button" disabled={busy}>{busy ? 'Signing in…' : lockedUser ? 'Unlock workspace' : 'Sign in'}<ArrowRight size={16} /></button>
      </form>
      {lockedUser && <button className="text-button" onClick={onSwitch}>Sign in as another user</button>}
      <p className="login-help">Need an account or a password reset? Contact your BCIS owner or system administrator.</p>
      <section className="login-connection" aria-label="System connection"><div><span className={`connection-dot ${ready ? 'online' : ''}`} /><strong aria-live="polite">{status}</strong><button className="icon-button" aria-label="Refresh connection" onClick={() => void refresh()} disabled={checking}><RefreshCw size={15} /></button></div>
        <small>API: {checking ? 'Checking' : connected ? 'Connected' : 'Unavailable'} · Database: {checking ? 'Checking' : ready ? 'Ready' : 'Not ready'}</small>
        {connection?.kind === 'unavailable' && <p>{connection.message}</p>}
        {connected && !ready && <p>Start PostgreSQL and apply migrations, then refresh.</p>}
      </section>
    </div><footer>Authorized office access</footer></main>
  </div>;
}
