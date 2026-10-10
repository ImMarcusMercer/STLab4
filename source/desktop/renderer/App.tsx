import { MasterPage } from './pages/MasterPage';
import { useEffect, useState } from 'react';
import { ClipboardList, CreditCard, FileText, HardDriveDownload, LayoutDashboard, LockKeyhole, RefreshCw, Settings2, Users, Wallet, Cable } from 'lucide-react';
import type { ConnectionResult } from '../../shared/contracts';
import { roleNames, type Actor } from '../../shared/auth';
import { UsersPage } from './pages/UsersPage';
import { BillingPage } from './pages/BillingPage';
import { PaymentsPage } from './pages/PaymentsPage';
import { CollectionsPage } from './pages/CollectionsPage';
import { ReceivablesPage } from './pages/ReceivablesPage';
import { ReportsPage } from './pages/ReportsPage';
import { BackupsPage } from './pages/BackupsPage';

const navigation = [
  { name: 'Subscribers', icon: Users, permission: 'subscriber.view', summary: 'Find and manage subscriber accounts.' },
  { name: 'Billing', icon: FileText, permission: 'billing.view', summary: 'Review cycles, invoices and account ledgers.' },
  { name: 'Payments', icon: CreditCard, permission: 'payment.view', summary: 'Record payments and review receipts.' },
  { name: 'Collections', icon: Wallet, permission: 'collection.view', summary: 'Manage routes, batches and remittances.' },
  { name: 'Receivables', icon: ClipboardList, permission: 'receivable.view', summary: 'Follow up overdue balances and service actions.' },
  { name: 'Services', icon: Cable, permission: 'service.view', summary: 'Review plans and service accounts.' },
  { name: 'Reports', icon: FileText, permission: 'report.view', summary: 'View performance and export reports.' },
  { name: 'Backups', icon: HardDriveDownload, permission: 'backup.view', summary: 'Review and verify office backups.' },
  { name: 'Administration', icon: Settings2, permission: 'user.manage', summary: 'Manage staff accounts and access.' },
];

const pageTargets = {
  Administration: 'users', Subscribers: 'subscribers', Services: 'services', Collections: 'collections',
  Billing: 'billing', Payments: 'payments', Receivables: 'receivables', Reports: 'reports', Backups: 'backups',
} as const;
type Page = 'overview' | typeof pageTargets[keyof typeof pageTargets];
const pageTitles: Record<Page, string> = {
  overview: 'Overview', users: 'Administration', subscribers: 'Subscribers', services: 'Services',
  collections: 'Collections', billing: 'Billing', payments: 'Payments', receivables: 'Receivables', reports: 'Reports', backups: 'Backups',
};

export function App({ user, onLock, onLogout, onUnauthorized, onSessionRefresh }: { user: Actor; onLock(): void; onLogout(): void; onUnauthorized(): void; onSessionRefresh(): Promise<void> }) {
  const [page, setPage] = useState<Page>('overview');
  const [connection, setConnection] = useState<ConnectionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState<string>();

  async function refresh() {
    setLoading(true);
    try { setConnection(await window.bcis.getSystemStatus()); }
    catch { setConnection({ kind: 'unavailable', message: 'The desktop connection could not be checked. Restart the application and try again.' }); }
    finally { setLoading(false); setCheckedAt(new Date().toLocaleTimeString()); }
  }
  useEffect(() => { void refresh(); }, []);

  const ready = connection?.kind === 'status' && connection.data.status === 'ready';
  const title = loading ? 'Checking connection…' : ready ? 'Workspace connected' : 'Connection needs attention';
  const description = loading ? 'Checking access to your office records.'
    : ready ? 'Your office records are available.'
    : 'Office records are unavailable right now. Check the office network or ask your administrator for help, then try again.';

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">B</span><div><strong>BCIS</strong><span>Billing & collections</span></div></div>
      <div className="office-label"><span className="office-dot" /> Bukidnon office</div>
      <nav aria-label="Main navigation">
        <p className="nav-label">WORKSPACE</p>
        <button className={`nav-item ${page === 'overview' ? 'active' : ''}`} aria-current={page === 'overview' ? 'page' : undefined} onClick={() => setPage('overview')}><LayoutDashboard size={18} /> Overview</button>
        {navigation.filter((item) => user.permissions.includes(item.permission)).map(({ name, icon: Icon }) => {
          const target = pageTargets[name as keyof typeof pageTargets];
          return <button key={name} className={`nav-item ${page === target ? 'active' : ''}`} onClick={() => setPage(target)}><Icon size={18}/><span>{name}</span></button>;
        })}
      </nav>
      <div className="sidebar-footer"><div><strong>{user.displayName}</strong><span>{user.roles.map((role) => roleNames[role]).join(', ')}</span></div></div>
    </aside>

    <main>
      <header className="topbar"><div>Workspace <span>/</span> <strong>{pageTitles[page]}</strong></div><div className="session-actions"><button onClick={onLock}><LockKeyhole size={14} />Lock workspace</button><button onClick={onLogout}>Sign out</button></div></header>
      <div className="page-content">
        {page === 'users' && user.permissions.includes('user.manage') ? <UsersPage user={user} onUnauthorized={onUnauthorized} onSessionRefresh={onSessionRefresh} /> : page === 'billing' && user.permissions.includes('billing.view') ? <BillingPage user={user} onUnauthorized={onUnauthorized} /> : page === 'payments' && user.permissions.includes('payment.view') ? <PaymentsPage user={user} onUnauthorized={onUnauthorized} /> : page === 'collections' && user.permissions.includes('collection.view') ? <CollectionsPage user={user} onUnauthorized={onUnauthorized} /> : page === 'receivables' && user.permissions.includes('receivable.view') ? <ReceivablesPage user={user} onUnauthorized={onUnauthorized} />
        : page === 'reports' && user.permissions.includes('report.view') ? <ReportsPage user={user} onUnauthorized={onUnauthorized} />
        : page === 'backups' && user.permissions.includes('backup.view') ? <BackupsPage user={user} onUnauthorized={onUnauthorized} />
        : page === 'subscribers' || page === 'services' ? <MasterPage key={page} initial={page} user={user} onUnauthorized={onUnauthorized}/> : <>
        <div className="page-heading"><div><p className="eyebrow">BUKIDNON CABLE & INTERNET SERVICES</p><h1>Your BCIS workspace</h1><p className="muted">Welcome, {user.displayName}. Choose where to start.</p></div></div>
        <section className={`workspace-status ${!loading && !ready ? 'attention' : ''}`} aria-label="System connection" aria-busy={loading} role={!loading && !ready ? 'alert' : 'status'}>
          <span className={`connection-dot ${ready ? 'online' : ''}`} aria-hidden="true" />
          <div><strong>{title}</strong><p>{description}</p></div>
          <button className="refresh-button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? 'spinning' : ''} />{ready ? 'Check again' : 'Try again'}</button>
        </section>
        <div className="section-heading"><div><h2>Work areas</h2><p className="muted">Only areas available to your account are shown.</p></div></div>
        <div className="workspace-grid">
          {navigation.filter(item => user.permissions.includes(item.permission)).map(item => <button key={item.name} className="workspace-link" onClick={() => setPage(pageTargets[item.name as keyof typeof pageTargets])}>
            <strong>{item.name}</strong><span>{item.summary}</span>
          </button>)}
        </div>
        {!navigation.some(item => user.permissions.includes(item.permission)) && <p className="info-note">No work areas are assigned to your account. Ask your administrator to review your access.</p>}
        <footer className="page-footer"><span>BCIS Subscription Billing and Collection System</span>{checkedAt && <span>Connection checked {checkedAt}</span>}</footer>
        </>}
      </div>
    </main>
  </div>;
}
