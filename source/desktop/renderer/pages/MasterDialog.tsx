import { useEffect, useRef, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { decimalMoney, masterInputs, parseCentavos, type MasterRecord, type Resource } from '../../../shared/master-data';
import { listRecords, masterConfig, saveRecord, type Field } from './master-config';

function ReferenceField({ field, value, disabled, onChange }: { field: Field; value: string; disabled: boolean; onChange(value: string): void }) {
  const [search,setSearch] = useState(''); const [items,setItems] = useState<MasterRecord[]>([]); const [selected,setSelected] = useState<MasterRecord | null>(null); const [error,setError] = useState('');
  useEffect(() => {
    if (!value) { setSelected(null); return; } let current = true;
    void window.bcis.getMasterRecord(field.resource!,value).then(result => { if (current && result.ok) setSelected(result.data); });
    return () => { current = false; };
  },[field.resource,value]);
  useEffect(() => {
    if (disabled) return; let current = true;
    const timer = setTimeout(() => { void listRecords(field.resource!,{ q: search, perPage: 30, status: 'ACTIVE' }).then(result => { if (!current) return; if (result.ok) { setItems(result.data.items); setError(''); } else setError(result.error.message); }); },150);
    return () => { current = false; clearTimeout(timer); };
  },[search,field.resource,disabled]);
  const choices = selected && !items.some(row => row.id === selected.id) ? [selected,...items] : items;
  return <div className="reference-field">{!disabled && <input aria-label={`Search ${field.label.toLowerCase()}`} placeholder="Search code or name…" value={search} onChange={event => setSearch(event.target.value)} />}
    <select aria-label={field.label} value={value} disabled={disabled} required={!field.optional} onChange={event => onChange(event.target.value)}><option value="">{field.optional ? 'Unassigned' : 'Select a record'}</option>{value && !choices.some(row => row.id === value) && <option value={value}>Current reference ({value})</option>}{choices.map(row => <option key={row.id} value={row.id}>{row.code} — {'name' in row ? row.name : row.code}</option>)}</select>{!disabled && <small>Showing up to 30 matches. Search to find another record.</small>}{error && <small className="field-error">{error}</small>}</div>;
}

export function MasterDialog({ resource, record, mode, onClose, onSaved, onUnauthorized }: { resource: Resource; record: MasterRecord | null; mode: 'edit' | 'view' | 'assign'; onClose(): void; onSaved(): void; onUnauthorized(): void }) {
  const dialog = useRef<HTMLDialogElement>(null); const config = masterConfig[resource];
  const [values,setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(config.fields.map(field => { const original = record ? (record as unknown as Record<string, unknown>)[field.key] : config.defaults[field.key]; return [field.key,field.type === 'money' ? decimalMoney(original as number) : field.type === 'addresses' ? (original as string[]).join('\n') : original ?? '']; })));
  const [reason,setReason] = useState(record ? '' : 'Initial setup'); const [errors,setErrors] = useState<Record<string,string>>({}); const [error,setError] = useState(''); const [busy,setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); },[]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setErrors({}); setError('');
    const data: Record<string,unknown> = {};
    for (const field of config.fields) {
      const value = values[field.key];
      data[field.key] = field.type === 'money' ? parseCentavos(String(value)) : field.type === 'number' ? value === '' && field.optional ? null : Number(value) : field.type === 'addresses' ? String(value).split('\n').map(line => line.trim()).filter(Boolean) : (field.type === 'reference' || field.type === 'date') && value === '' ? null : value;
    }
    const parsed = masterInputs[resource].safeParse(data);
    if (!parsed.success) { setErrors(Object.fromEntries(parsed.error.issues.map(issue => [String(issue.path[0]),issue.message]))); setError('Check the highlighted fields.'); return; }
    if (reason.trim().length < 3) { setErrors({ reason: 'Enter a reason (at least 3 characters).' }); return; }
    setBusy(true);
    try {
      const result = mode === 'assign' && record ? await (resource === 'subscribers' ? window.bcis.assignSubscriber : window.bcis.assignService)(record.id,{ areaId: data.areaId as string | null, collectorId: data.collectorId as string | null, version: record.version, reason }) : await saveRecord(resource,record,parsed.data,reason);
      if (result.ok) onSaved(); else { setError(result.error.message); setErrors(Object.fromEntries(Object.entries(result.error.fields ?? {}).map(([key,messages]) => [key,messages.join(' ')]))); if (result.error.status === 401) onUnauthorized(); }
    } catch { setError('The record could not be saved. Check the connection and try again.'); }
    finally { setBusy(false); }
  }
  return <dialog className="account-dialog master-dialog" ref={dialog} aria-labelledby="master-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><header><div><p className="eyebrow">{config.title}</p><h2 id="master-title">{mode === 'view' ? 'View' : mode === 'assign' ? 'Assign' : record ? 'Edit' : 'New'} {config.singular}</h2></div><button className="icon-button" aria-label="Close record" disabled={busy} onClick={onClose}><X size={18}/></button></header>
    {error && <div className="form-alert" role="alert">{error}</div>}
    <form className="account-form" onSubmit={event => void submit(event)}><div className="master-form-grid">{config.fields.map(field => {
      const disabled = busy || mode === 'view' || (mode === 'assign' && !['areaId','collectorId'].includes(field.key)) || Boolean(record && field.immutable);
      const set = (value: unknown) => setValues(previous => ({ ...previous,[field.key]: value })); const value = values[field.key];
      return <div className={`master-field ${['textarea','addresses'].includes(field.type ?? '') ? 'full-width' : ''}`} key={field.key}>
        <label htmlFor={`master-${field.key}`}>{field.label}{!field.optional && field.type !== 'checkbox' && <span aria-hidden="true"> *</span>}</label>
        {field.type === 'reference' ? <ReferenceField field={field} value={String(value)} disabled={disabled} onChange={set}/> : field.type === 'select' ? <select id={`master-${field.key}`} aria-label={field.label} value={String(value)} disabled={disabled} onChange={event => set(event.target.value)}>{field.options!.map(option => <option key={option}>{option}</option>)}</select> : field.type === 'textarea' || field.type === 'addresses' ? <textarea id={`master-${field.key}`} aria-label={field.label} value={String(value)} disabled={disabled} required={!field.optional} rows={3} onChange={event => set(event.target.value)}/> : field.type === 'checkbox' ? <input id={`master-${field.key}`} type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={event => set(event.target.checked)}/> : <input id={`master-${field.key}`} aria-label={field.label} type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'} inputMode={field.type === 'money' ? 'decimal' : undefined} value={String(value)} disabled={disabled} required={!field.optional} onChange={event => set(event.target.value)}/>}
        {errors[field.key] && <small className="field-error" role="alert">{errors[field.key]}</small>}
      </div>;
    })}</div>
    {resource === 'services' && <p className="muted">The current rate is explicit. Plan price edits do not change it. Plan revision: {record?.planVersion ?? 'saved on creation'}.</p>}
    {mode !== 'view' && <label>Reason for change<input aria-label="Reason for change" value={reason} required minLength={3} maxLength={500} onChange={event => setReason(event.target.value)}/>{errors.reason && <small className="field-error">{errors.reason}</small>}</label>}
    <footer><button type="button" className="refresh-button" disabled={busy} onClick={onClose}>{mode === 'view' ? 'Close' : 'Cancel'}</button>{mode !== 'view' && <button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save record'}</button>}</footer></form>
  </dialog>;
}
