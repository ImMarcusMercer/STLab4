import type { RoleCode } from '../../shared/auth';

export const rolePermissions: Record<RoleCode, string[]> = {
  OWNER: ['dashboard.view', 'subscriber.view', 'subscriber.manage', 'plan.manage', 'service.view', 'service.manage', 'billing.view', 'billing.generate', 'payment.view', 'payment.create', 'payment.verify', 'payment.reverse', 'collection.view', 'collection.manage', 'collection.reconcile', 'receivable.view', 'report.view', 'report.export', 'audit.view', 'user.manage', 'backup.create', 'backup.restore'],
  ADMIN: ['dashboard.view', 'subscriber.view', 'subscriber.manage', 'plan.manage', 'service.view', 'service.manage', 'billing.view', 'billing.generate', 'payment.view', 'payment.create', 'payment.verify', 'collection.view', 'collection.manage', 'collection.reconcile', 'receivable.view', 'report.view', 'report.export'],
  CASHIER: ['dashboard.view', 'subscriber.view', 'billing.view', 'payment.view', 'payment.create', 'payment.verify'],
  SUPERVISOR: ['dashboard.view', 'subscriber.view', 'collection.view', 'collection.manage', 'collection.reconcile', 'receivable.view', 'report.view', 'report.export'],
  AUDITOR: ['dashboard.view', 'payment.view', 'payment.reverse', 'receivable.view', 'report.view', 'report.export', 'audit.view'],
  TECHNICIAN: ['service.view'],
  VIEWER: ['dashboard.view', 'report.view'],
};
