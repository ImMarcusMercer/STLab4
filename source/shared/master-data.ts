import { z } from 'zod';

const code = z.string().trim().toUpperCase().min(2).max(40).regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Use letters, numbers, hyphens or underscores.');
const name = z.string().trim().min(2).max(160);
const text = z.string().trim().max(2000);
const contact = z.string().trim().max(100);
const money = z.number().int().min(0).max(999999999);
const day = z.number().int().min(1).max(31);
const reference = z.uuid().nullable();
const date = z.iso.date();
export const assignmentShape = { areaId: reference, collectorId: reference };
export const PlanInput = z.object({ code, name, serviceType: z.enum(['INTERNET', 'CABLE', 'COMBO']), priceCentavos: money, installationFeeCentavos: money, reconnectionFeeCentavos: money, description: text, speedMbps: z.number().int().min(1).max(100000).nullable(), channelCount: z.number().int().min(1).max(10000).nullable(), active: z.boolean() }).strict().refine(v => !(v.serviceType === 'CABLE' && v.speedMbps !== null) && !(v.serviceType === 'INTERNET' && v.channelCount !== null), { message: 'Speed applies to Internet/Combo; channels apply to Cable/Combo.', path: ['serviceType'] });
export const AreaInput = z.object({ code, name, description: text, active: z.boolean() }).strict();
export const CollectorInput = z.object({ code, name, contact, notes: text, active: z.boolean() }).strict();
export const SubscriberInput = z.object({ code, name, contact, email: z.union([z.email(), z.literal('')]), addresses: z.array(z.string().trim().min(3).max(500)).min(1).max(20), ...assignmentShape, billingDay: day, dueDay: day, status: z.enum(['ACTIVE', 'INACTIVE', 'TERMINATED', 'ARCHIVED']), notes: text }).strict();
export const ServiceInput = z.object({ code, subscriberId: z.uuid(), planId: z.uuid(), installationAddress: z.string().trim().min(3).max(500), activationDate: date.nullable(), billingStartDate: date, billingDay: day, dueDay: day, currentRateCentavos: money, status: z.enum(['PENDING', 'ACTIVE', 'INACTIVE', 'TERMINATED', 'ARCHIVED']), ...assignmentShape, notes: text }).strict().refine(v => v.status !== 'ACTIVE' || v.activationDate !== null, { path: ['activationDate'], message: 'An active service requires an activation date.' }).refine(v => !v.activationDate || v.billingStartDate >= v.activationDate, { path: ['billingStartDate'], message: 'Billing cannot start before activation.' });
export const masterInputs = { plans: PlanInput, areas: AreaInput, collectors: CollectorInput, subscribers: SubscriberInput, services: ServiceInput };
export type Resource = keyof typeof masterInputs;
export type MasterInputs = { [K in Resource]: z.infer<typeof masterInputs[K]> };
export type MasterRecord<K extends Resource = Resource> = MasterInputs[K] & { id: string; version: number; createdAt: string; planVersion?: number };
export const ListQuery = z.object({ q: z.string().trim().max(200).default(''), page: z.coerce.number().int().min(1).max(1000000).default(1), perPage: z.coerce.number().int().min(1).max(100).default(20), sort: z.enum(['name', 'code']).default('code'), direction: z.enum(['asc', 'desc']).default('asc'), status: z.string().max(20).optional(), subscriberId: z.uuid().optional() }).strict();
export type MasterQuery = z.input<typeof ListQuery>;
export type MasterList<K extends Resource = Resource> = { items: MasterRecord<K>[]; total: number; page: number; perPage: number };
export const EditMetadata = z.object({ version: z.number().int().positive().optional(), reason: z.string().trim().min(3).max(500) });
export type SaveInput<K extends Resource> = { data: MasterInputs[K]; reason: string; version?: number };
export const AssignmentInput = z.object({ ...assignmentShape, version: z.number().int().positive(), reason: z.string().trim().min(3).max(500) }).strict();
export type Assignment = z.infer<typeof AssignmentInput>;
export const HistorySchema = z.object({ items: z.array(z.object({ version: z.number().int(), snapshot: z.record(z.string(), z.unknown()), reason: z.string(), actorName: z.string(), createdAt: z.string() })), total: z.number(), page: z.number(), perPage: z.number() });
export type MasterHistory = z.infer<typeof HistorySchema>;
export function recordSchema<K extends Resource>(resource: K): z.ZodType<MasterRecord<K>> {
  return masterInputs[resource].safeExtend({ id: z.uuid(), version: z.number().int().positive(), createdAt: z.string(), planVersion: z.number().int().positive().optional() }) as unknown as z.ZodType<MasterRecord<K>>;
}

// Exact conversion from UI decimal text; no floating-point monetary arithmetic.
export function parseCentavos(value: string): number | null {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ''] = value.trim().split('.');
  const amount = Number(BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')));
  return amount <= 999999999 ? amount : null;
}
export function decimalMoney(value: number): string { return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`; }

