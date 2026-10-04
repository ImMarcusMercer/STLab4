import { useState } from 'react';
import { PlugZap, ShieldCheck, Wrench } from 'lucide-react';
import type { Actor } from '../../../shared/auth';
import { moneyLabel } from '../../../shared/receivables';
import type { ServiceTechnician, Suspension } from '../../../shared/receivables';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * One suspension document, with the four things that can still be done to it.
 *
 * Each step is offered only when the document is in the state that step belongs to, and each
 * step asks for the written reason the office would have to stand behind later. The panel
 * holds no state of its own: every button forwards the command and redraws from the document
 * the API answers with, so a refusal on the server leaves the screen showing the truth.
 */
export function SuspensionPanel({ suspension, technicians, user, onUnauthorized, onChanged }: {
  suspension: Suspension;
  technicians: ServiceTechnician[];
  user: Actor;
  onUnauthorized(): void;
  onChanged(): void;
}) {
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [technicianId, setTechnicianId] = useState('');
  const [completedOn, setCompletedOn] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canControl = user.permissions.includes('service.control');

  async function run(action: () => Promise<{ ok: true; data: Suspension } | { ok: false; error: { status: number; message: string; fields?: Record<string, string[]> } }>, success: (value: Suspension) => string) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await action();
      if (result.ok) { setNotice(success(result.data)); setReason(''); setNotes(''); setTechnicianId(''); onChanged(); }
      else { setError(result.error.message); if (result.error.status === 401) onUnauthorized(); }
    } catch { setError('The command could not be completed. Nothing was changed.'); }
    finally { setBusy(false); }
  }

  const lift = () => run(() => window.bcis.liftSuspension(suspension.id, { reason: reason.trim() }), value => `${value.suspensionNumber} was lifted and the reason was filed against it.`);
  const request = () => run(() => window.bcis.requestReconnection(suspension.id, { notes: notes.trim() }), value => `Reconnection ${value.reconnectionNumber} was raised with ${moneyLabel(value.reconnectionFeeCentavos)} from the policy.`);
  const assign = () => run(() => window.bcis.assignTechnician(suspension.id, { technicianId, notes: notes.trim() }), value => `A technician was assigned to ${value.reconnectionNumber}.`);
  const complete = () => run(() => window.bcis.completeReconnection(suspension.id, { completedOn, notes: notes.trim() }), value => `${value.reconnectionNumber} was completed and the service was restored.`);

  const active = suspension.status === 'ACTIVE';
  const open = suspension.reconnectionStatus === 'REQUESTED' || suspension.reconnectionStatus === 'ASSIGNED';

  return <section className="panel billing-command" aria-label={`Suspension ${suspension.suspensionNumber}`}>
    <h3>{suspension.suspensionNumber} · {suspension.subscriberName}</h3>
    <p className="muted">
      {suspension.address} · {suspension.planCode} · area {suspension.areaName || 'unassigned'} · collector {suspension.collectorName || 'unassigned'}
    </p>
    <dl className="detail-grid">
      <div><dt>Reason</dt><dd>{suspension.reason}</dd></div>
      <div><dt>Effective</dt><dd>{suspension.effectiveDate}</dd></div>
      <div><dt>Arrears frozen</dt><dd>{moneyLabel(suspension.arrearsAtSuspensionCentavos)}</dd></div>
      <div><dt>Months unpaid</dt><dd>{suspension.monthsUnpaidAtSuspension}</dd></div>
      <div><dt>Policy applied</dt><dd>{suspension.gracePeriodDays} day(s) grace · {moneyLabel(suspension.thresholdCentavos)} threshold</dd></div>
      <div><dt>Approved by</dt><dd>{suspension.approvedName}</dd></div>
      {suspension.status === 'LIFTED' && <div><dt>Lifted</dt><dd>{suspension.liftedAt} by {suspension.liftedByName ?? '—'}</dd></div>}
      {suspension.reconnectionNumber && <>
        <div><dt>Reconnection</dt><dd>{suspension.reconnectionNumber} · {suspension.reconnectionStatus}</dd></div>
        <div><dt>Reconnection fee</dt><dd>{moneyLabel(suspension.reconnectionFeeCentavos)}</dd></div>
        <div><dt>Technician</dt><dd>{suspension.technicianName ?? 'Unassigned'}</dd></div>
        <div><dt>Completed</dt><dd>{suspension.reconnectionCompletedDate ?? 'Not yet'}</dd></div>
      </>}
    </dl>
    {suspension.notes && <p className="muted">Notes on file: {suspension.notes}</p>}
    {error && <div className="form-alert" role="alert">{error}</div>}
    {notice && <div className="success-notice" role="status">{notice}</div>}

    {!canControl && <p className="muted">This account may only be read here. Disconnecting and restoring service needs the service control permission.</p>}

    {/* A reconnection is raised against a suspension that is still in force: the customer pays
        first, asks for service back, and the document is lifted when the visit is completed.
        Lifting by hand is the other route, for a disconnection that is simply being written off. */}
    {canControl && active && !suspension.reconnectionNumber && <div className="billing-command-fields">
      <label>Notes<input aria-label="Reconnection notes" maxLength={500} value={notes} onChange={event => setNotes(event.target.value)} placeholder="Optional" /></label>
      <button className="primary-button" type="button" aria-label="Request reconnection" disabled={busy} onClick={() => void request()}><PlugZap size={15}/>Request reconnection</button>
    </div>}

    {canControl && active && !suspension.reconnectionNumber && <div className="billing-command-fields">
      <label>Reason for lifting<input aria-label="Reason for lifting" maxLength={500} value={reason} onChange={event => setReason(event.target.value)} placeholder="Why service is being restored without a visit" /></label>
      <button className="text-button" type="button" aria-label="Lift suspension" disabled={busy || reason.trim().length < 3} onClick={() => void lift()}><ShieldCheck size={15}/>Lift suspension</button>
    </div>}

    {canControl && open && suspension.reconnectionStatus === 'REQUESTED' && <div className="billing-command-fields">
      <label>Technician<select aria-label="Choose technician" required value={technicianId} onChange={event => setTechnicianId(event.target.value)}><option value="">Choose a technician</option>{technicians.map(technician => <option key={technician.id} value={technician.id}>{technician.displayName}</option>)}</select></label>
      <label>Notes<input aria-label="Assignment notes" maxLength={500} value={notes} onChange={event => setNotes(event.target.value)} placeholder="Optional" /></label>
      <button className="primary-button" type="button" aria-label="Assign technician" disabled={busy || !technicianId} onClick={() => void assign()}><Wrench size={15}/>Assign technician</button>
    </div>}

    {canControl && open && suspension.reconnectionStatus === 'ASSIGNED' && <div className="billing-command-fields">
      <label>Completed on<input aria-label="Completion date" type="date" max={today()} value={completedOn} onChange={event => setCompletedOn(event.target.value)} /></label>
      <label>Notes<input aria-label="Completion notes" maxLength={500} value={notes} onChange={event => setNotes(event.target.value)} placeholder="Optional" /></label>
      <button className="primary-button" type="button" aria-label="Complete reconnection" disabled={busy} onClick={() => void complete()}><PlugZap size={15}/>Complete reconnection</button>
    </div>}

    <p className="muted">A reconnection can only be raised once the account owes nothing, and only one may be open at a time. Both documents stay on the record after the service is restored.</p>
  </section>;
}
