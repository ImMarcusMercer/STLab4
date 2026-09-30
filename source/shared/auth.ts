import { z } from 'zod';

export const RoleCode = z.enum(['OWNER', 'ADMIN', 'CASHIER', 'SUPERVISOR', 'AUDITOR', 'TECHNICIAN', 'VIEWER']);
export type RoleCode = z.infer<typeof RoleCode>;
export const roleNames: Record<RoleCode, string> = { OWNER: 'Owner / Super Admin', ADMIN: 'Administrator', CASHIER: 'Cashier', SUPERVISOR: 'Collection Supervisor', AUDITOR: 'Accounting / Auditor', TECHNICIAN: 'Technician', VIEWER: 'Read-only Viewer' };
export const Username = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/, 'Use 3–64 letters, digits, dots, underscores or hyphens.');
export const LoginInput = z.object({ username: Username, password: z.string().min(1).max(128) }).strict();
export type LoginInput = z.infer<typeof LoginInput>;
export const NewUserInput = z.object({ username: Username, displayName: z.string().trim().min(2).max(100), password: z.string().min(12).max(128), roles: z.array(RoleCode).min(1).max(7).transform((roles) => [...new Set(roles)]) }).strict();
export type NewUserInput = z.infer<typeof NewUserInput>;
export const UpdateUserInput = NewUserInput.omit({ username: true }).partial().extend({ active: z.boolean().optional() }).strict().refine((value) => Object.keys(value).length > 0, 'Provide at least one change.');
export type UpdateUserInput = z.infer<typeof UpdateUserInput>;
export const ActorSchema = z.object({ id: z.uuid(), username: Username, displayName: z.string(), active: z.boolean(), roles: z.array(RoleCode), permissions: z.array(z.string()) });
export type Actor = z.infer<typeof ActorSchema>;
export const UserListSchema = z.object({ items: z.array(ActorSchema), page: z.number().int(), perPage: z.number().int(), total: z.number().int() });
export type UserList = z.infer<typeof UserListSchema>;
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: { status: number; message: string; fields?: Record<string, string[]> } };
