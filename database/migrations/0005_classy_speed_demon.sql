DROP INDEX "ledger_entry_no_idx";--> statement-breakpoint
-- The statement number now restarts at 1 per subscriber and is allocated by the API
-- under a row lock, so the global bigserial sequence is no longer used.
ALTER TABLE "ledger_entries" ALTER COLUMN "entry_no" DROP DEFAULT;--> statement-breakpoint
ALTER SEQUENCE "ledger_entries_entry_no_seq" OWNED BY NONE;--> statement-breakpoint
DROP SEQUENCE "ledger_entries_entry_no_seq";--> statement-breakpoint
ALTER TABLE "ledger_entries" ALTER COLUMN "entry_no" SET DATA TYPE integer;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_subscriber_entry_idx" ON "ledger_entries" USING btree ("subscriber_id","entry_no");