-- Phase 9 index review. Every index here answers a query the system actually runs, and each
-- one is justified by a measured plan rather than by guesswork. See docs/PHASE9.md section 8
-- and the evidence in scripts/performance-check.ts.
--
-- 1. Open-invoice lookups. The receivables report, the collections route and the payment panel
--    all ask "what does this account still owe?" by service account or by subscriber. Both are
--    partial indexes over the rows that actually owe something, so a settled account costs
--    nothing and an index stays small on a database with years of closed invoices behind it.
--    `invoices_subscriber_idx (subscriber_id, issue_date)` cannot serve this: its leading column
--    is right but the open/closed filter is not in the index, so the closed rows are read too.
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS invoices_open_service_idx ON invoices(service_account_id,due_date) WHERE status IN ('UNPAID','PARTIALLY_PAID','OVERDUE') AND balance_centavos>0;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS invoices_open_subscriber_idx ON invoices(subscriber_id,due_date) WHERE status NOT IN ('DRAFT','VOID') AND balance_centavos>0;--> statement-breakpoint
-- 2. The last payment on a statement and on the aging row. Both ask for one row, the most
--    recent posted payment, ordered exactly as the index is, with the amount carried along so
--    the answer comes from the index rather than from the heap.
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payments_posted_subscriber_idx ON payments(subscriber_id,received_on DESC,created_at DESC) INCLUDE (amount_centavos) WHERE status='POSTED' AND direction='PAYMENT';--> statement-breakpoint
-- 3. The audit trail report reads a date range in order. The existing index leads with the
--    actor, which a date-range report does not know.
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at,action);--> statement-breakpoint
-- 4. Search. The list screens search with ILIKE '%term%', which no b-tree index can serve at
--    any size, so the two tables that grow with the subscriber count get trigram indexes - one
--    per searched column, because the planner combines them with a bitmap OR exactly as the
--    query combines the columns.
--
--    pg_trgm is a contributed extension. Where it cannot be installed the search still works,
--    by scanning; it is simply slower on a large subscriber list. The guard is here so a
--    deployment on a restricted server records no failed migration, rather than refusing to
--    start. The reference tables (plans, areas, collectors) are not indexed: they hold tens of
--    rows, where a scan costs nothing.
DO $bcis$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='pg_trgm') THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_trgm';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS subscribers_code_trgm_idx ON subscribers USING gin (code gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS subscribers_name_trgm_idx ON subscribers USING gin (name gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS subscribers_contact_trgm_idx ON subscribers USING gin (contact gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS subscribers_email_trgm_idx ON subscribers USING gin (email gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS subscribers_addresses_trgm_idx ON subscribers USING gin ((addresses::text) gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS service_accounts_code_trgm_idx ON service_accounts USING gin (code gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS service_accounts_address_trgm_idx ON service_accounts USING gin (installation_address gin_trgm_ops)';
  END IF;
END
$bcis$;