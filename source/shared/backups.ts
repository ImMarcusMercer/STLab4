import { z } from 'zod';

/**
 * Backup and restore contracts.
 *
 * These live in `shared` because the desktop parses them too, and a schema defined only in the
 * API would let the renderer and the server disagree about what a backup record is. The restore
 * confirmation phrase is part of the typed input on purpose: a restore replaces every posted
 * figure in the database, so it cannot be an operation a stray click triggers.
 */

export const BackupKindSchema = z.enum(['FULL', 'DATABASE']);
export type BackupKind = z.infer<typeof BackupKindSchema>;

/**
 * The tables whose row counts a restore is checked against.
 *
 * A dump can restore every table and still be the wrong backup: restoring an empty database
 * would satisfy a naive "did it restore" check. So the counts are recorded when the backup is
 * taken and compared one table at a time afterwards, and any difference is reported rather than
 * tolerated. The server uses this same list to take the counts, so the two cannot drift.
 */
export const countedTables = [
  'subscribers', 'service_accounts', 'invoices', 'invoice_items', 'ledger_entries', 'payments',
  'payment_allocations', 'payment_proofs', 'collection_batches', 'batch_accounts', 'suspensions',
  'reconnections', 'users', 'audit_logs',
] as const;

/**
 * A backup that failed before it counted anything holds an empty object, so the keys are checked
 * for membership but not required: an exhaustive record would make a recorded failure unreadable.
 */
export const RowCountsSchema = z.partialRecord(z.enum(countedTables), z.number().int().nonnegative());
export type RowCounts = z.infer<typeof RowCountsSchema>;

export const BackupRecordSchema = z.object({
  id: z.uuid(),
  kind: BackupKindSchema,
  /**
   * Both of these are held to the pattern the database itself enforces with a check constraint.
   * A record whose name or digest does not match is not something this API wrote, so the desktop
   * refuses it rather than showing an operator a backup the server cannot possibly have produced.
   */
  fileName: z.string().regex(/^[a-f0-9-]{36}\.dump$/),
  /** Zero for a backup that failed before it produced a file, which is why this is not positive. */
  byteSize: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  rowCounts: RowCountsSchema,
  attachmentCount: z.number().int().nonnegative(),
  attachmentBytes: z.number().int().nonnegative(),
  note: z.string(),
  status: z.enum(['COMPLETED', 'FAILED']),
  failureReason: z.string(),
  createdBy: z.uuid().nullable(),
  createdAt: z.string(),
  verifiedAt: z.string().nullable(),
  restoredAt: z.string().nullable(),
  restoredBy: z.uuid().nullable(),
});
export type BackupRecord = z.infer<typeof BackupRecordSchema>;

export const BackupListSchema = z.object({
  backups: z.array(BackupRecordSchema),
  /** Shown so an operator knows where to copy a backup to removable media. */
  storagePath: z.string(),
});
export type BackupList = z.infer<typeof BackupListSchema>;

export const CreateBackupInputSchema = z.object({
  kind: BackupKindSchema.default('FULL'),
  note: z.string().max(200).default(''),
});
export type CreateBackupInput = z.infer<typeof CreateBackupInputSchema>;

export const RestoreBackupInputSchema = z.object({
  confirm: z.literal('RESTORE'),
  reason: z.string().min(3).max(400),
});
export type RestoreBackupInput = z.infer<typeof RestoreBackupInputSchema>;

export const RowCountDifferenceSchema = z.object({
  table: z.string(),
  expected: z.number().int(),
  actual: z.number().int(),
});
export type RowCountDifference = z.infer<typeof RowCountDifferenceSchema>;

/**
 * What a restore actually achieved.
 *
 * `verified` is false when the restored row counts differ from the ones the backup recorded,
 * and `differences` names the tables. A restore that reported plain success while the
 * subscriber count had changed would be worse than one that reports a problem, so the report
 * carries the detail rather than a verdict alone.
 */
export const RestoreReportSchema = z.object({
  fileName: z.string(),
  verified: z.boolean(),
  digestMatched: z.boolean(),
  rowCountsMatched: z.boolean(),
  differences: z.array(RowCountDifferenceSchema),
  attachmentsRestored: z.number().int().nonnegative(),
  restoredAt: z.string(),
});
export type RestoreReport = z.infer<typeof RestoreReportSchema>;

export const BackupVerificationSchema = z.object({
  fileName: z.string(),
  digestMatched: z.boolean(),
  readable: z.boolean(),
  checkedAt: z.string(),
});
export type BackupVerification = z.infer<typeof BackupVerificationSchema>;