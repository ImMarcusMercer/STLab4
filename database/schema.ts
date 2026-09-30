import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid, boolean, primaryKey, index, jsonb, integer, date, check, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { invoiceStatusValues, invoiceItemTypeValues, ledgerReferenceValues } from '../source/shared/billing';
import { paymentMethodValues, paymentStatusValues, allocationSourceValues, proofMimeValues } from '../source/shared/payments';

// Workflow-owned domain tables are introduced with their respective phases.
export const applicationMetadata = pgTable('application_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const roles = pgTable('roles', { code: text('code').primaryKey(), name: text('name').notNull() });
export const permissions = pgTable('permissions', { code: text('code').primaryKey() });
export const userRoles = pgTable('user_roles', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleCode: text('role_code').notNull().references(() => roles.code),
}, (table) => [primaryKey({ columns: [table.userId, table.roleCode] })]);
export const rolePermissions = pgTable('role_permissions', {
  roleCode: text('role_code').notNull().references(() => roles.code),
  permissionCode: text('permission_code').notNull().references(() => permissions.code),
}, (table) => [primaryKey({ columns: [table.roleCode, table.permissionCode] })]);
export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('sessions_user_idx').on(table.userId), index('sessions_expiry_idx').on(table.expiresAt)]);
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: uuid('actor_id').references(() => users.id),
  action: text('action').notNull(),
  subjectId: uuid('subject_id'),
  details: jsonb('details').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('audit_actor_created_idx').on(table.actorId, table.createdAt)]);


const identity = () => ({ id: uuid('id').primaryKey().defaultRandom(), code: text('code').notNull().unique(), version: integer('version').notNull().default(1), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow() });
export const servicePlans = pgTable('service_plans', {
  ...identity(), name: text('name').notNull(), serviceType: text('service_type').notNull(), priceCentavos: integer('price_centavos').notNull(), installationFeeCentavos: integer('installation_fee_centavos').notNull(), reconnectionFeeCentavos: integer('reconnection_fee_centavos').notNull(), description: text('description').notNull(), speedMbps: integer('speed_mbps'), channelCount: integer('channel_count'), active: boolean('active').notNull().default(true),
}, t => [check('plan_money_nonnegative', sql`${t.priceCentavos} >= 0 AND ${t.installationFeeCentavos} >= 0 AND ${t.reconnectionFeeCentavos} >= 0`), check('plan_type', sql`${t.serviceType} IN ('INTERNET','CABLE','COMBO')`)]);
export const collectionAreas = pgTable('collection_areas', { ...identity(), name: text('name').notNull(), description: text('description').notNull(), active: boolean('active').notNull().default(true) });
export const collectors = pgTable('collectors', { ...identity(), name: text('name').notNull(), contact: text('contact').notNull(), notes: text('notes').notNull(), active: boolean('active').notNull().default(true) });
const assignments = () => ({ areaId: uuid('area_id').references(() => collectionAreas.id), collectorId: uuid('collector_id').references(() => collectors.id) });
export const subscribers = pgTable('subscribers', { ...identity(), name: text('name').notNull(), contact: text('contact').notNull(), email: text('email').notNull(), addresses: jsonb('addresses').notNull(), ...assignments(), billingDay: integer('billing_day').notNull(), dueDay: integer('due_day').notNull(), status: text('status').notNull(), notes: text('notes').notNull() }, t => [index('subscriber_name_idx').on(t.name), index('subscriber_contact_idx').on(t.contact), index('subscriber_area_idx').on(t.areaId), index('subscriber_collector_idx').on(t.collectorId), check('subscriber_days', sql`${t.billingDay} BETWEEN 1 AND 31 AND ${t.dueDay} BETWEEN 1 AND 31`), check('subscriber_status', sql`${t.status} IN ('ACTIVE','INACTIVE','TERMINATED','ARCHIVED')`)]);
export const serviceAccounts = pgTable('service_accounts', { ...identity(), subscriberId: uuid('subscriber_id').notNull().references(() => subscribers.id), planId: uuid('plan_id').notNull().references(() => servicePlans.id), planVersion: integer('plan_version').notNull(), installationAddress: text('installation_address').notNull(), activationDate: date('activation_date'), billingStartDate: date('billing_start_date').notNull(), billingDay: integer('billing_day').notNull(), dueDay: integer('due_day').notNull(), currentRateCentavos: integer('current_rate_centavos').notNull(), status: text('status').notNull(), ...assignments(), notes: text('notes').notNull() }, t => [index('service_subscriber_idx').on(t.subscriberId), index('service_plan_idx').on(t.planId), index('service_area_idx').on(t.areaId), index('service_collector_idx').on(t.collectorId), check('service_rate', sql`${t.currentRateCentavos} >= 0`), check('service_days', sql`${t.billingDay} BETWEEN 1 AND 31 AND ${t.dueDay} BETWEEN 1 AND 31`), check('service_status', sql`${t.status} IN ('PENDING','ACTIVE','INACTIVE','TERMINATED','ARCHIVED')`)]);
export const masterHistory = pgTable('master_history', { id: uuid('id').primaryKey().defaultRandom(), resource: text('resource').notNull(), recordId: uuid('record_id').notNull(), version: integer('version').notNull(), snapshot: jsonb('snapshot').notNull(), reason: text('reason').notNull(), actorId: uuid('actor_id').notNull().references(() => users.id), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow() }, t => [uniqueIndex('master_history_revision_idx').on(t.resource, t.recordId, t.version)]);

// Billing and ledger. Amounts are integer centavos; posted rows are append-only and
// database triggers reject edits or deletes. See docs/PHASE4.md for the policies.
const money = (name: string) => integer(name).notNull();
const moneyBounds = (column: AnyPgColumn) => check(`${column.name}_nonnegative`, sql`${column} >= 0 AND ${column} <= 999999999`);
// Discounts and credits reduce an invoice, so the adjustment column is signed while
// every stored total and balance stays non-negative.
const signedMoneyBounds = (column: AnyPgColumn) => check(`${column.name}_signed`, sql`${column} >= -999999999 AND ${column} <= 999999999`);
// The allowed values come from the shared contract, so the database constraint and the
// Zod enum can never drift apart. The values are compile-time constants, never input.
const oneOf = (name: string, column: AnyPgColumn, values: readonly string[]) => check(name, sql`${column} IN (${sql.raw(values.map(value => `'${value}'`).join(','))})`);
export const billingCycles = pgTable('billing_cycles', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check('billing_cycle_code', sql`${t.code} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  check('billing_cycle_range', sql`${t.periodEnd} >= ${t.periodStart}`),
]);

// One counter per document kind and year; allocated with a row lock so numbers are
// gap-free under concurrent posting and are never reused after a void.
export const documentSequences = pgTable('document_sequences', {
  kind: text('kind').notNull(),
  year: integer('year').notNull(),
  nextValue: integer('next_value').notNull().default(1001),
}, t => [
  primaryKey({ columns: [t.kind, t.year] }),
  oneOf('document_sequence_kind', t.kind, ['INVOICE', 'RECEIPT']),
  check('document_sequence_start', sql`${t.nextValue} >= 1001`),
]);

export const billingRuns = pgTable('billing_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  cycleId: uuid('cycle_id').notNull().references(() => billingCycles.id),
  asOf: date('as_of').notNull(),
  actorId: uuid('actor_id').notNull().references(() => users.id),
  invoiceCount: integer('invoice_count').notNull(),
  skippedCount: integer('skipped_count').notNull(),
  totalCentavos: integer('total_centavos').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  // AT-11: a period can be generated only once; a repeat returns the stored run.
  uniqueIndex('billing_runs_cycle_idx').on(t.cycleId),
  check('billing_run_counts', sql`${t.invoiceCount} >= 0 AND ${t.skippedCount} >= 0`),
  moneyBounds(t.totalCentavos),
]);

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceNumber: text('invoice_number').unique(),
  cycleId: uuid('cycle_id').references(() => billingCycles.id),
  runId: uuid('run_id').references(() => billingRuns.id),
  subscriberId: uuid('subscriber_id').notNull().references(() => subscribers.id),
  serviceAccountId: uuid('service_account_id').notNull().references(() => serviceAccounts.id),
  status: text('status').notNull(),
  source: text('source').notNull(),
  periodLabel: text('period_label').notNull(),
  issueDate: date('issue_date').notNull(),
  dueDate: date('due_date').notNull(),
  subtotalCentavos: money('subtotal_centavos'),
  adjustmentCentavos: money('adjustment_centavos'),
  totalCentavos: money('total_centavos'),
  paidCentavos: money('paid_centavos'),
  balanceCentavos: money('balance_centavos'),
  notes: text('notes').notNull().default(''),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidReason: text('void_reason').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  // AT-11: at most one finalised invoice per service account and billing period.
  uniqueIndex('invoices_service_cycle_idx').on(t.serviceAccountId, t.cycleId).where(sql`${t.status} NOT IN ('DRAFT','VOID')`),
  index('invoices_due_status_idx').on(t.dueDate, t.status),
  index('invoices_subscriber_idx').on(t.subscriberId, t.issueDate),
  index('invoices_cycle_idx').on(t.cycleId),
  oneOf('invoice_status', t.status, invoiceStatusValues),
  check('invoice_source', sql`${t.source} IN ('CYCLE','MANUAL')`),
  check('invoice_due_date', sql`${t.dueDate} >= ${t.issueDate}`),
  check('invoice_totals', sql`${t.subtotalCentavos} + ${t.adjustmentCentavos} = ${t.totalCentavos} AND ${t.balanceCentavos} = ${t.totalCentavos} - ${t.paidCentavos}`),
  check('invoice_draft_unpaid', sql`${t.status} = 'DRAFT' OR ${t.status} = 'VOID' OR ${t.invoiceNumber} IS NOT NULL`),
  check('invoice_voided', sql`${t.status} = 'VOID' OR ${t.voidedAt} IS NULL`),
  moneyBounds(t.subtotalCentavos), signedMoneyBounds(t.adjustmentCentavos), moneyBounds(t.totalCentavos), moneyBounds(t.paidCentavos), moneyBounds(t.balanceCentavos),
]);

export const invoiceItems = pgTable('invoice_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'restrict' }),
  lineNo: integer('line_no').notNull(),
  itemType: text('item_type').notNull(),
  description: text('description').notNull(),
  serviceAccountId: uuid('service_account_id').references(() => serviceAccounts.id),
  planId: uuid('plan_id').references(() => servicePlans.id),
  planVersion: integer('plan_version'),
  planCode: text('plan_code').notNull().default(''),
  planName: text('plan_name').notNull().default(''),
  quantity: integer('quantity').notNull().default(1),
  unitPriceCentavos: money('unit_price_centavos'),
  amountCentavos: integer('amount_centavos').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('invoice_items_line_idx').on(t.invoiceId, t.lineNo),
  oneOf('invoice_item_type', t.itemType, invoiceItemTypeValues),
  check('invoice_item_quantity', sql`${t.quantity} >= 1 AND ${t.quantity} <= 1000`),
  // Discounts and credit adjustments are negative; a debit adjustment may be either sign.
  check('invoice_item_sign', sql`(${t.itemType} = 'DISCOUNT' AND ${t.amountCentavos} < 0) OR (${t.itemType} = 'ADJUSTMENT') OR (${t.itemType} NOT IN ('DISCOUNT','ADJUSTMENT') AND ${t.amountCentavos} >= 0)`),
  check('invoice_item_amount', sql`abs(${t.amountCentavos}) <= 999999999`),
  moneyBounds(t.unitPriceCentavos),
]);

export const adjustments = pgTable('adjustments', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'restrict' }),
  adjustmentType: text('adjustment_type').notNull(),
  amountCentavos: money('amount_centavos'),
  reason: text('reason').notNull(),
  actorId: uuid('actor_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('adjustments_invoice_idx').on(t.invoiceId, t.createdAt),
  oneOf('adjustment_type', t.adjustmentType, ['DEBIT', 'CREDIT']),
  check('adjustment_positive', sql`${t.amountCentavos} >= 1 AND ${t.amountCentavos} <= 999999999`),
]);

export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Statement line number, restarting at 1 for every subscriber, so a subscriber
  // ledger reads 1, 2, 3 exactly like the laboratory worksheet.
  entryNo: integer('entry_no').notNull(),
  subscriberId: uuid('subscriber_id').notNull().references(() => subscribers.id),
  serviceAccountId: uuid('service_account_id').references(() => serviceAccounts.id),
  invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'restrict' }),
  entryDate: date('entry_date').notNull(),
  referenceType: text('reference_type').notNull(),
  referenceId: uuid('reference_id'),
  referenceNumber: text('reference_number').notNull().default(''),
  description: text('description').notNull(),
  debitCentavos: money('debit_centavos'),
  creditCentavos: money('credit_centavos'),
  balanceCentavos: integer('balance_centavos').notNull(),
  reversalOfId: uuid('reversal_of_id').references((): AnyPgColumn => ledgerEntries.id, { onDelete: 'restrict' }),
  actorId: uuid('actor_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('ledger_subscriber_entry_idx').on(t.subscriberId, t.entryNo),
  index('ledger_subscriber_order_idx').on(t.subscriberId, t.entryDate, t.entryNo),
  index('ledger_invoice_idx').on(t.invoiceId),
  index('ledger_reference_idx').on(t.referenceType, t.referenceId),
  oneOf('ledger_reference_type', t.referenceType, ledgerReferenceValues),
  check('ledger_single_side', sql`NOT (${t.debitCentavos} > 0 AND ${t.creditCentavos} > 0)`),
  check('ledger_nonzero', sql`${t.debitCentavos} + ${t.creditCentavos} > 0`),
  check('ledger_balance_range', sql`${t.balanceCentavos} BETWEEN -999999999999 AND 999999999999`),
  moneyBounds(t.debitCentavos), moneyBounds(t.creditCentavos),
]);

// Payments. Money received is one ledger credit line per posted payment, an allocation
// records which invoice that money settled, and whatever is left stays as an advance
// credit. A posted payment is never edited or deleted: a recorded entry that never
// applied is voided, and a posted one is reversed. See docs/PHASE5.md.
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Gap-free like an invoice number, so a receipt proves which document it belongs to.
  receiptNumber: text('receipt_number').unique(),
  subscriberId: uuid('subscriber_id').notNull().references(() => subscribers.id),
  method: text('method').notNull(),
  direction: text('direction').notNull().default('PAYMENT'),
  status: text('status').notNull(),
  amountCentavos: money('amount_centavos'),
  receivedOn: date('received_on').notNull(),
  // AT-05: a GCash reference identifies one transfer, so it is reserved permanently
  // unless the entry was voided before it was ever posted.
  referenceNumber: text('reference_number'),
  notes: text('notes').notNull().default(''),
  reason: text('reason').notNull().default(''),
  reversalOfId: uuid('reversal_of_id').references((): AnyPgColumn => payments.id, { onDelete: 'restrict' }),
  recordedBy: uuid('recorded_by').notNull().references(() => users.id),
  verifiedBy: uuid('verified_by').references(() => users.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  // `voidedAt` records why an entry stopped applying, whether it was voided before
  // posting or reversed after posting, so both states keep an audited reason.
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidReason: text('void_reason').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('payments_subscriber_idx').on(t.subscriberId, t.receivedOn),
  index('payments_status_idx').on(t.status, t.receivedOn),
  uniqueIndex('payments_gcash_reference_idx').on(t.referenceNumber).where(sql`${t.method} = 'GCASH' AND ${t.status} <> 'VOID'`),
  oneOf('payment_method', t.method, paymentMethodValues),
  oneOf('payment_status', t.status, paymentStatusValues),
  oneOf('payment_direction', t.direction, ['PAYMENT', 'REVERSAL']),
  check('payment_reference', sql`${t.direction} = 'REVERSAL' OR (${t.method} = 'GCASH' AND length(${t.referenceNumber}) > 0) OR (${t.method} = 'CASH' AND ${t.referenceNumber} IS NULL)`),
  check('payment_pairing', sql`(${t.direction} = 'PAYMENT' AND ${t.reversalOfId} IS NULL) OR (${t.direction} = 'REVERSAL' AND ${t.reversalOfId} IS NOT NULL AND length(${t.reason}) > 0)`),
  // The state machine, so a receipt, a verification and a reason can never be missing
  // from a state that claims them.
  check('payment_state', sql`(${t.status} = 'PENDING' AND ${t.receiptNumber} IS NULL AND ${t.voidedAt} IS NULL AND ${t.method} = 'GCASH' AND ${t.direction} = 'PAYMENT')
    OR (${t.status} = 'POSTED' AND ${t.receiptNumber} IS NOT NULL AND ${t.voidedAt} IS NULL AND (${t.method} = 'CASH' OR ${t.verifiedAt} IS NOT NULL) AND (${t.direction} = 'PAYMENT' OR ${t.reversalOfId} IS NOT NULL))
    OR (${t.status} = 'VOID' AND ${t.voidedAt} IS NOT NULL AND length(${t.voidReason}) > 0)
    OR (${t.status} = 'REVERSED' AND ${t.voidedAt} IS NOT NULL AND length(${t.voidReason}) > 0 AND ${t.direction} = 'PAYMENT')`),
  moneyBounds(t.amountCentavos),
]);

export const paymentAllocations = pgTable('payment_allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  paymentId: uuid('payment_id').notNull().references(() => payments.id, { onDelete: 'restrict' }),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'restrict' }),
  // PAYMENT settles the money just received, ADVANCE spends a credit already held.
  source: text('source').notNull(),
  amountCentavos: money('amount_centavos'),
  // A reversal keeps the row and marks it, so the allocation history stays complete.
  reversedAt: timestamp('reversed_at', { withTimezone: true }),
  actorId: uuid('actor_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('payment_allocation_invoice_idx').on(t.paymentId, t.invoiceId),
  index('payment_allocation_payment_idx').on(t.paymentId),
  index('payment_allocation_invoice_lookup_idx').on(t.invoiceId),
  oneOf('payment_allocation_source', t.source, allocationSourceValues),
  check('payment_allocation_positive', sql`${t.amountCentavos} >= 1`),
  moneyBounds(t.amountCentavos),
]);

// AT-05: the stored file name is generated by the server, the original name is kept for
// the operator only, and the digest lets a backup be verified after a restore. One
// payment carries one proof, so the attachment always belongs to a single entry.
export const paymentProofs = pgTable('payment_proofs', {
  id: uuid('id').primaryKey().defaultRandom(),
  paymentId: uuid('payment_id').notNull().references(() => payments.id, { onDelete: 'restrict' }),
  originalName: text('original_name').notNull(),
  storedName: text('stored_name').notNull().unique(),
  mimeType: text('mime_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  sha256: text('sha256').notNull(),
  uploadedBy: uuid('uploaded_by').notNull().references(() => users.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('payment_proofs_payment_idx').on(t.paymentId),
  oneOf('payment_proof_mime_type', t.mimeType, proofMimeValues),
  check('payment_proof_byte_size', sql`${t.byteSize} >= 1 AND ${t.byteSize} <= 5242880`),
  check('payment_proof_digest', sql`${t.sha256} ~ '^[a-f0-9]{64}$'`),
  check('payment_proof_stored_name', sql`${t.storedName} ~ '^[a-f0-9-]{36}\\.(png|jpg|pdf)$'`),
]);
