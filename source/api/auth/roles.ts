import type { RoleCode } from '../../shared/auth';

/**
 * Backup permissions are split by what they can do, not by which screen shows them.
 *
 * `backup.view` and `backup.verify` are read-only: an auditor's job is to confirm that the
 * backups actually restore, and that must not require the ability to destroy the database.
 * `backup.restore` replaces every posted figure in the system, so it is deliberately absent from
 * ADMIN and AUDITOR even though both may take and inspect backups.
 */
export const rolePermissions: Record<RoleCode, string[]> = {
  OWNER: ['dashboard.view', 'subscriber.view', 'subscriber.manage', 'plan.manage', 'service.view', 'service.manage', 'billing.view', 'billing.generate', 'payment.view', 'payment.create', 'payment.verify', 'payment.reverse', 'collection.view', 'collection.manage', 'collection.reconcile', 'receivable.view', 'service.control', 'report.view', 'report.export', 'audit.view', 'user.manage', 'backup.view', 'backup.verify', 'backup.create', 'backup.restore'],
  ADMIN: ['dashboard.view', 'subscriber.view', 'subscriber.manage', 'plan.manage', 'service.view', 'service.manage', 'billing.view', 'billing.generate', 'payment.view', 'payment.create', 'payment.verify', 'collection.view', 'collection.manage', 'collection.reconcile', 'receivable.view', 'service.control', 'report.view', 'report.export', 'backup.view', 'backup.verify', 'backup.create'],
  CASHIER: ['dashboard.view', 'subscriber.view', 'billing.view', 'payment.view', 'payment.create', 'payment.verify'],
  SUPERVISOR: ['dashboard.view', 'subscriber.view', 'collection.view', 'collection.manage', 'collection.reconcile', 'receivable.view', 'service.control', 'report.view', 'report.export'],
  AUDITOR: ['dashboard.view', 'payment.view', 'payment.reverse', 'receivable.view', 'report.view', 'report.export', 'audit.view', 'backup.view', 'backup.verify'],
  TECHNICIAN: ['service.view'],
  VIEWER: ['dashboard.view', 'report.view'],
};
