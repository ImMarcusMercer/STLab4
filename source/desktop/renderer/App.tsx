import { MasterPage } from './pages/MasterPage';
import { useEffect, useState } from 'react';
import { ArrowRight, Cable, Check, CircleHelp, ClipboardList, CreditCard, FileText, LayoutDashboard, LockKeyhole, RefreshCw, Server, Settings2, ShieldCheck, Users, Wallet, Wifi } from 'lucide-react';
import type { ConnectionResult } from '../../shared/contracts';
import { roleNames, type Actor } from '../../shared/auth';
import { UsersPage } from './pages/UsersPage';
import { BillingPage } from './pages/BillingPage';
import { PaymentsPage } from './pages/PaymentsPage';
import { CollectionsPage } from './pages/CollectionsPage';

const navigation = [
  { name: 'Subscribers', icon: Users, permission: 'subscriber.view' }, { name: 'Billing', icon: FileText, permission: 'billing.view' },
  { name: 'Payments', icon: CreditCard, permission: 'payment.view' }, { name: 'Collections', icon: Wallet, permission: 'collection.view' },
  { name: 'Receivables', icon: ClipboardList, permission: 'receivable.view' }, { name: 'Services', icon: Cable, permission: 'service.view' },
  { name: 'Reports', icon: FileText, permission: 'report.view' }, { name: 'Administration', icon: Settings2, permission: 'user.manage' },
];

export function App({ user, onLock, onLogout, onUnauthorized, onSessionRefresh }: { user: Actor; onLock(): void; onLogout(): void; onUnauthorized(): void; onSessionRefresh(): Promise<void> }) {
  const [page, setPage] = useState<'overview' | 'users' | 'subscribers' | 'services' | 'areas' | 'collections' | 'billing' | 'payments'>('overview');
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
  const degraded = connection?.kind === 'status' && connection.data.status === 'degraded';
  const title = loading ? 'Checking your connection' : ready ? 'All systems connected' : degraded ? 'Database needs attention' : 'API unavailable';
  const description = loading ? 'Connecting to the BCIS server and checking database readiness.'
    : ready ? 'The desktop, API server and PostgreSQL database are communicating.'
    : degraded ? 'The API is running, but PostgreSQL or its migrations are unavailable. Start the database and apply migrations.'
    : connection?.kind === 'unavailable' ? connection.message : 'Refresh to check the connection.';

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Wifi size={23} /></span><div><strong>BCIS</strong><span>Billing & collections</span></div></div>
      <div className="office-label"><span className="office-dot" /> Bukidnon office <span className="version">v0.1</span></div>
      <nav aria-label="Main navigation">
        <p className="nav-label">WORKSPACE</p>
        <button className={`nav-item ${page === 'overview' ? 'active' : ''}`} aria-current={page === 'overview' ? 'page' : undefined} onClick={() => setPage('overview')}><LayoutDashboard size={18} /> Overview</button>
        {navigation.filter((item) => user.permissions.includes(item.permission)).map(({ name, icon: Icon }) => {
          const target = name === 'Administration' ? 'users' : name === 'Subscribers' ? 'subscribers' : name === 'Services' ? 'services' : name === 'Collections' ? 'collections' : name === 'Billing' ? 'billing' : name === 'Payments' ? 'payments' : null;
          return <button key={name} className={`nav-item ${page === target ? 'active' : ''}`} disabled={!target} onClick={() => { if (target) setPage(target); }} title={target ? name : `${name} will be added in a later phase`}><Icon size={18}/><span>{name}</span>{!target && <LockKeyhole className="nav-lock" size={12}/>}</button>;
        })}
      </nav>
      <div className="sidebar-footer"><ShieldCheck size={19} /><div><strong>{user.displayName}</strong><span>{user.roles.map((role) => roleNames[role]).join(', ')}</span></div></div>
    </aside>

    <main>
      <header className="topbar"><div>Workspace <span>/</span> <strong>{{ users: 'Administration', overview: 'Overview', subscribers: 'Subscribers', services: 'Services', areas: 'Collections', collections: 'Collections', billing: 'Billing', payments: 'Payments' }[page]}</strong></div><div className="session-actions"><button onClick={onLock}><LockKeyhole size={14} />Lock workspace</button><button onClick={onLogout}>Sign out</button></div></header>
      <div className="page-content">
        {page === 'users' && user.permissions.includes('user.manage') ? <UsersPage user={user} onUnauthorized={onUnauthorized} onSessionRefresh={onSessionRefresh} /> : page === 'billing' && user.permissions.includes('billing.view') ? <BillingPage user={user} onUnauthorized={onUnauthorized} /> : page === 'payments' && user.permissions.includes('payment.view') ? <PaymentsPage user={user} onUnauthorized={onUnauthorized} /> : page === 'collections' && user.permissions.includes('collection.view') ? <CollectionsPage user={user} onUnauthorized={onUnauthorized} /> : page === 'subscribers' || page === 'services' || page === 'areas' ? <MasterPage key={page} initial={page} user={user} onUnauthorized={onUnauthorized}/> : <>
        <div className="page-heading"><div><p className="eyebrow">BUKIDNON CABLE & INTERNET SERVICES</p><h1>Your BCIS workspace</h1><p className="muted">A connected foundation for your billing and collection operations.</p></div><span className="heading-icon"><Cable size={29} /></span></div>

        <section className={`connection-card ${!loading && !ready ? 'attention' : ''}`} aria-label="System connection" aria-busy={loading}>
          <div className="connection-summary"><span className="connection-icon"><Server size={25} /></span><div aria-live="polite"><h2>{title}</h2><p>{description}</p></div><button className="refresh-button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? 'spinning' : ''} />Refresh connection</button></div>
          <div className="connection-nodes">
            <div><span className="step-number">01</span><div><strong>Desktop client</strong><small>Electron + React</small></div><span className="badge good"><Check size={12} />Running</span></div>
            <ArrowRight className="flow-arrow" size={17} />
            <div><span className="step-number">02</span><div><strong>API server</strong><small>Central application service</small></div><span className={`badge ${connection?.kind === 'status' ? 'good' : 'neutral'}`}>{loading ? 'Checking' : connection?.kind === 'status' ? 'Connected' : 'Unavailable'}</span></div>
            <ArrowRight className="flow-arrow" size={17} />
            <div><span className="step-number">03</span><div><strong>Database</strong><small>PostgreSQL</small></div><span className={`badge ${ready ? 'good' : 'neutral'}`}>{loading ? 'Checking' : ready ? 'Ready' : 'Not ready'}</span></div>
          </div>
          <div className="connection-foot"><span>Connection is checked against the live server.</span><span>{checkedAt ? `Last checked ${checkedAt}` : 'Checking now…'}</span></div>
        </section>

        <div className="section-heading"><div><h2>Building your operations workspace</h2><p className="muted">The laboratory is organized into ten implementation phases.</p></div><span className="subtle-label">PROJECT ROADMAP</span></div>
        <div className="roadmap-grid">
          <section className="panel foundation-panel"><div className="panel-top"><span className="panel-symbol"><LayoutDashboard size={20} /></span><span className="badge blue">Current milestone</span></div><h3>Project foundation</h3><p>A separate desktop and API with a shared, transactional database.</p><ul className="foundation-list"><li><Check size={15} />Secure desktop boundary</li><li><Check size={15} />API connection and readiness checks</li><li><Check size={15} />Versioned database migrations</li><li><Check size={15} />Automated foundation tests</li></ul><div className="panel-bottom">01 <span>Architecture & setup</span></div></section>
          <section className="panel"><div className="panel-top"><span className="panel-symbol"><Users size={20} /></span><span className="badge blue">Account maintenance ready</span></div><h3>People & subscriptions</h3><p>Plans, subscribers, services and collection assignments are available.</p><ol className="future-list"><li><span>02</span>Authentication & role permissions</li><li><span>03</span>Plans, subscribers & services</li></ol><div className="panel-note"><ShieldCheck size={14} />Your permissions are checked by the API</div></section>
          <section className="panel"><div className="panel-top"><span className="panel-symbol"><Wallet size={20} /></span><span className="badge good">Collections ready</span></div><h3>Billing & collections</h3><p>Invoices, payments, collection routes, remittances and receivables are available.</p><ol className="future-list"><li><span>04</span>Invoices & subscriber ledger</li><li><span>05</span>Payments, receipts & advance credit</li><li><span>06</span>Collection routes & remittances</li><li><span>07</span>Receivables & aging</li><li><span>08–10</span>Reports, deployment & QA</li></ol><div className="panel-note"><ShieldCheck size={14} />Every amount is decided by the API</div></section>
        </div>
        <div className="info-note"><CircleHelp size={19} /><p><strong>Account access is ready.</strong> Plans, subscribers, services, the billing engine, payment collection and collection routes are available. Cash and GCash payments, receipt numbering, void and reversal follow the same permission and history rules. Your visible navigation follows the permissions assigned to your account.</p></div>
        <footer className="page-footer"><span>BCIS Subscription Billing and Collection System</span><span>Local development workspace</span></footer>
        </>}
      </div>
    </main>
  </div>;
}
