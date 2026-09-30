import { masterInputs, type Resource, type MasterRecord, type MasterQuery } from '../../../shared/master-data';
export type Field = { key: string; label: string; type?: 'text' | 'textarea' | 'addresses' | 'number' | 'money' | 'date' | 'checkbox' | 'select' | 'reference'; options?: string[]; resource?: Resource; optional?: boolean; immutable?: boolean };
const code = (label = 'Code'): Field => ({ key: 'code', label, immutable: true });
const name: Field = { key: 'name', label: 'Name' };
const active: Field = { key: 'active', label: 'Active', type: 'checkbox' };
const notes: Field = { key: 'notes', label: 'Notes', type: 'textarea', optional: true };
const contact: Field = { key: 'contact', label: 'Contact number', optional: true };
const description: Field = { key: 'description', label: 'Description', type: 'textarea', optional: true };
const assignment: Field[] = [{ key: 'areaId', label: 'Collection area', type: 'reference', resource: 'areas', optional: true }, { key: 'collectorId', label: 'Assigned collector', type: 'reference', resource: 'collectors', optional: true }];
const days: Field[] = [{ key: 'billingDay', label: 'Billing day (1–31)', type: 'number' }, { key: 'dueDay', label: 'Due day (1–31)', type: 'number' }];
export const masterConfig: Record<Resource, { title: string; singular: string; permission: string; fields: Field[]; defaults: Record<string, unknown> }> = {
  plans: { title: 'Plans', singular: 'plan', permission: 'plan.manage', fields: [code(), name, { key: 'serviceType', label: 'Service type', type: 'select', options: ['INTERNET','CABLE','COMBO'], immutable: true }, { key: 'priceCentavos', label: 'Monthly price (PHP)', type: 'money' }, { key: 'installationFeeCentavos', label: 'Installation fee (PHP)', type: 'money' }, { key: 'reconnectionFeeCentavos', label: 'Reconnection fee (PHP)', type: 'money' }, { key: 'speedMbps', label: 'Speed (Mbps)', type: 'number', optional: true }, { key: 'channelCount', label: 'Channel count', type: 'number', optional: true }, description, active], defaults: { code: '', name: '', serviceType: 'INTERNET', priceCentavos: 0, installationFeeCentavos: 0, reconnectionFeeCentavos: 0, speedMbps: null, channelCount: null, description: '', active: true } },
  areas: { title: 'Areas & routes', singular: 'area', permission: 'collection.manage', fields: [code(),name,description,active], defaults: { code: '',name: '',description: '',active: true } },
  collectors: { title: 'Collectors', singular: 'collector', permission: 'collection.manage', fields: [code(),name,contact,notes,active], defaults: { code: '',name: '',contact: '',notes: '',active: true } },
  subscribers: { title: 'Subscribers', singular: 'subscriber', permission: 'subscriber.manage', fields: [code('Account number'),name,contact,{ key: 'email', label: 'Email', optional: true },{ key: 'addresses', label: 'Addresses (one per line)', type: 'addresses' },...assignment,...days,{ key: 'status', label: 'Status', type: 'select', options: ['ACTIVE','INACTIVE','TERMINATED','ARCHIVED'] },notes], defaults: { code: '',name: '',contact: '',email: '',addresses: [],areaId: null,collectorId: null,billingDay: 1,dueDay: 15,status: 'ACTIVE',notes: '' } },
  services: { title: 'Service accounts', singular: 'service', permission: 'service.manage', fields: [code('Service number'),{ key: 'subscriberId', label: 'Subscriber', type: 'reference', resource: 'subscribers', immutable: true },{ key: 'planId', label: 'Plan', type: 'reference', resource: 'plans' },{ key: 'installationAddress', label: 'Installation address' },{ key: 'activationDate', label: 'Activation date', type: 'date', optional: true },{ key: 'billingStartDate', label: 'Billing start date', type: 'date' },...days,{ key: 'currentRateCentavos', label: 'Current rate (PHP)', type: 'money' },{ key: 'status', label: 'Status', type: 'select', options: ['PENDING','ACTIVE','INACTIVE','TERMINATED','ARCHIVED'] },...assignment,notes], defaults: { code: '',subscriberId: '',planId: '',installationAddress: '',activationDate: null,billingStartDate: '',billingDay: 1,dueDay: 15,currentRateCentavos: 0,status: 'PENDING',areaId: null,collectorId: null,notes: '' } },
};
export function listRecords(resource: Resource, query: MasterQuery) {
  switch (resource) {
    case 'plans': return window.bcis.listPlans(query);
    case 'areas': return window.bcis.listAreas(query);
    case 'collectors': return window.bcis.listCollectors(query);
    case 'subscribers': return window.bcis.listSubscribers(query);
    case 'services': return window.bcis.listServices(query);
  }
}
export function saveRecord(resource: Resource, record: MasterRecord | null, data: unknown, reason: string) {
  const base = { reason, ...(record ? { version: record.version } : {}) }; const id = record?.id ?? null;
  switch (resource) {
    case 'plans': return window.bcis.savePlan(id,{ ...base, data: masterInputs.plans.parse(data) });
    case 'areas': return window.bcis.saveArea(id,{ ...base, data: masterInputs.areas.parse(data) });
    case 'collectors': return window.bcis.saveCollector(id,{ ...base, data: masterInputs.collectors.parse(data) });
    case 'subscribers': return window.bcis.saveSubscriber(id,{ ...base, data: masterInputs.subscribers.parse(data) });
    case 'services': return window.bcis.saveService(id,{ ...base, data: masterInputs.services.parse(data) });
  }
}
