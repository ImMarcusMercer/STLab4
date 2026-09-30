import { useEffect, useState } from 'react';
import type { Actor } from '../../shared/auth';
import { App } from './App';
import { LoginPage } from './pages/LoginPage';

export function SessionApp() {
  const [user, setUser] = useState<Actor | null>(null);
  const [locked, setLocked] = useState<Actor | null>(null);
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState('');

  async function refreshSession() {
    const result = await window.bcis.getSession();
    if (result.ok) setUser(result.data);
    else if (result.error.status === 401) { setUser(null); setLocked(null); setNotice('Your session ended. Sign in again to continue.'); }
  }
  useEffect(() => {
    void refreshSession().catch(() => setNotice('Unable to restore the desktop session. Please sign in.')).finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    if (!user) return;
    let current = true;
    const interval = setInterval(() => {
      void window.bcis.getSession().then((result) => {
        if (!current) return;
        if (result.ok && result.data) setUser(result.data);
        else if (result.ok || result.error.status === 401) { setUser(null); setLocked(null); setNotice('Your session ended. Sign in again to continue.'); }
      }).catch(() => { /* A network outage does not silently destroy the local session. */ });
    }, 60_000);
    return () => { current = false; clearInterval(interval); };
  }, [user]);

  async function endSession(action: 'lock' | 'logout') {
    setLocked(action === 'lock' ? user : null);
    setUser(null); setNotice('');
    const result = await (action === 'lock' ? window.bcis.lock() : window.bcis.logout());
    if (!result.ok) setNotice(result.error.message);
  }
  if (checking) return <div className="session-loading" role="status">Opening BCIS workspace…</div>;
  if (!user) return <LoginPage lockedUser={locked} notice={notice} onSwitch={() => { setLocked(null); setNotice(''); }} onSignedIn={(actor) => { setUser(actor); setLocked(null); setNotice(''); }} />;
  return <App user={user} onLock={() => void endSession('lock')} onLogout={() => void endSession('logout')} onSessionRefresh={refreshSession} onUnauthorized={() => { setUser(null); setLocked(null); setNotice('Your session ended. Sign in again to continue.'); }} />;
}
