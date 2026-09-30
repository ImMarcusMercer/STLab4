CREATE TABLE "adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"adjustment_type" text NOT NULL,
	"amount_centavos" integer NOT NULL,
	"reason" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adjustment_type" CHECK ("adjustments"."adjustment_type" IN ('DEBIT','CREDIT')),
	CONSTRAINT "adjustment_positive" CHECK ("adjustments"."amount_centavos" >= 1 AND "adjustments"."amount_centavos" <= 999999999)
);
--> statement-breakpoint
CREATE TABLE "billing_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_cycles_code_unique" UNIQUE("code"),
	CONSTRAINT "billing_cycle_code" CHECK ("billing_cycles"."code" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "billing_cycle_range" CHECK ("billing_cycles"."period_end" >= "billing_cycles"."period_start")
);
--> statement-breakpoint
CREATE TABLE "billing_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"actor_id" uuid NOT NULL,
	"invoice_count" integer NOT NULL,
	"skipped_count" integer NOT NULL,
	"total_centavos" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_run_counts" CHECK ("billing_runs"."invoice_count" >= 0 AND "billing_runs"."skipped_count" >= 0),
	CONSTRAINT "total_centavos_nonnegative" CHECK ("billing_runs"."total_centavos" >= 0 AND "billing_runs"."total_centavos" <= 999999999)
);
--> statement-breakpoint
CREATE TABLE "document_sequences" (
	"kind" text NOT NULL,
	"year" integer NOT NULL,
	"next_value" integer DEFAULT 1001 NOT NULL,
	CONSTRAINT "document_sequences_kind_year_pk" PRIMARY KEY("kind","year"),
	CONSTRAINT "document_sequence_kind" CHECK ("document_sequences"."kind" IN ('INVOICE','RECEIPT')),
	CONSTRAINT "document_sequence_start" CHECK ("document_sequences"."next_value" >= 1001)
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_type" text NOT NULL,
	"description" text NOT NULL,
	"service_account_id" uuid,
	"plan_id" uuid,
	"plan_version" integer,
	"plan_code" text DEFAULT '' NOT NULL,
	"plan_name" text DEFAULT '' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_centavos" integer NOT NULL,
	"amount_centavos" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_item_type" CHECK ("invoice_items"."item_type" IN ('SUBSCRIPTION','INSTALLATION','RECONNECTION','DISCOUNT','PENALTY','ADJUSTMENT')),
	CONSTRAINT "invoice_item_quantity" CHECK ("invoice_items"."quantity" >= 1 AND "invoice_items"."quantity" <= 1000),
	CONSTRAINT "invoice_item_sign" CHECK (("invoice_items"."item_type" = 'DISCOUNT' AND "invoice_items"."amount_centavos" < 0) OR ("invoice_items"."item_type" = 'ADJUSTMENT') OR ("invoice_items"."item_type" NOT IN ('DISCOUNT','ADJUSTMENT') AND "invoice_items"."amount_centavos" >= 0)),
	CONSTRAINT "invoice_item_amount" CHECK (abs("invoice_items"."amount_centavos") <= 999999999),
	CONSTRAINT "unit_price_centavos_nonnegative" CHECK ("invoice_items"."unit_price_centavos" >= 0 AND "invoice_items"."unit_price_centavos" <= 999999999)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" text,
	"cycle_id" uuid,
	"run_id" uuid,
	"subscriber_id" uuid NOT NULL,
	"service_account_id" uuid NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"period_label" text NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"subtotal_centavos" integer NOT NULL,
	"adjustment_centavos" integer NOT NULL,
	"total_centavos" integer NOT NULL,
	"paid_centavos" integer NOT NULL,
	"balance_centavos" integer NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"finalized_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number"),
	CONSTRAINT "invoice_status" CHECK ("invoices"."status" IN ('DRAFT','UNPAID','PARTIALLY_PAID','PAID','OVERDUE','VOID','CREDITED')),
	CONSTRAINT "invoice_source" CHECK ("invoices"."source" IN ('CYCLE','MANUAL')),
	CONSTRAINT "invoice_due_date" CHECK ("invoices"."due_date" >= "invoices"."issue_date"),
	CONSTRAINT "invoice_totals" CHECK ("invoices"."subtotal_centavos" + "invoices"."adjustment_centavos" = "invoices"."total_centavos" AND "invoices"."balance_centavos" = "invoices"."total_centavos" - "invoices"."paid_centavos"),
	CONSTRAINT "invoice_draft_unpaid" CHECK ("invoices"."status" = 'DRAFT' OR "invoices"."invoice_number" IS NOT NULL),
	CONSTRAINT "invoice_voided" CHECK ("invoices"."status" = 'VOID' OR "invoices"."voided_at" IS NULL),
	CONSTRAINT "subtotal_centavos_nonnegative" CHECK ("invoices"."subtotal_centavos" >= 0 AND "invoices"."subtotal_centavos" <= 999999999),
	CONSTRAINT "adjustment_centavos_nonnegative" CHECK ("invoices"."adjustment_centavos" >= 0 AND "invoices"."adjustment_centavos" <= 999999999),
	CONSTRAINT "total_centavos_nonnegative" CHECK ("invoices"."total_centavos" >= 0 AND "invoices"."total_centavos" <= 999999999),
	CONSTRAINT "paid_centavos_nonnegative" CHECK ("invoices"."paid_centavos" >= 0 AND "invoices"."paid_centavos" <= 999999999),
	CONSTRAINT "balance_centavos_nonnegative" CHECK ("invoices"."balance_centavos" >= 0 AND "invoices"."balance_centavos" <= 999999999)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_no" bigserial NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"service_account_id" uuid,
	"invoice_id" uuid,
	"entry_date" date NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" uuid,
	"reference_number" text DEFAULT '' NOT NULL,
	"description" text NOT NULL,
	"debit_centavos" integer NOT NULL,
	"credit_centavos" integer NOT NULL,
	"balance_centavos" integer NOT NULL,
	"reversal_of_id" uuid,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_reference_type" CHECK ("ledger_entries"."reference_type" IN ('INVOICE','VOID','ADJUSTMENT','PAYMENT','CREDIT')),
	CONSTRAINT "ledger_single_side" CHECK (NOT ("ledger_entries"."debit_centavos" > 0 AND "ledger_entries"."credit_centavos" > 0)),
	CONSTRAINT "ledger_nonzero" CHECK ("ledger_entries"."debit_centavos" + "ledger_entries"."credit_centavos" > 0),
	CONSTRAINT "ledger_balance_range" CHECK ("ledger_entries"."balance_centavos" BETWEEN -999999999999 AND 999999999999),
	CONSTRAINT "debit_centavos_nonnegative" CHECK ("ledger_entries"."debit_centavos" >= 0 AND "ledger_entries"."debit_centavos" <= 999999999),
	CONSTRAINT "credit_centavos_nonnegative" CHECK ("ledger_entries"."credit_centavos" >= 0 AND "ledger_entries"."credit_centavos" <= 999999999)
);
--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adjustments" ADD CONSTRAINT "adjustments_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_runs" ADD CONSTRAINT "billing_runs_cycle_id_billing_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."billing_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_runs" ADD CONSTRAINT "billing_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_plan_id_service_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."service_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_cycle_id_billing_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."billing_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_run_id_billing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."billing_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_reversal_of_id_ledger_entries_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "adjustments_invoice_idx" ON "adjustments" USING btree ("invoice_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_runs_cycle_idx" ON "billing_runs" USING btree ("cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_items_line_idx" ON "invoice_items" USING btree ("invoice_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_service_cycle_idx" ON "invoices" USING btree ("service_account_id","cycle_id") WHERE "invoices"."status" NOT IN ('DRAFT','VOID');--> statement-breakpoint
CREATE INDEX "invoices_due_status_idx" ON "invoices" USING btree ("due_date","status");--> statement-breakpoint
CREATE INDEX "invoices_subscriber_idx" ON "invoices" USING btree ("subscriber_id","issue_date");--> statement-breakpoint
CREATE INDEX "invoices_cycle_idx" ON "invoices" USING btree ("cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entry_no_idx" ON "ledger_entries" USING btree ("entry_no");--> statement-breakpoint
CREATE INDEX "ledger_subscriber_order_idx" ON "ledger_entries" USING btree ("subscriber_id","entry_date","entry_no");--> statement-breakpoint
CREATE INDEX "ledger_invoice_idx" ON "ledger_entries" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "ledger_reference_idx" ON "ledger_entries" USING btree ("reference_type","reference_id");--> statement-breakpoint
-- Posted financial history is append-only. The rules live in the database so no
-- application bug, direct SQL session or future endpoint can rewrite a charge.
CREATE OR REPLACE FUNCTION bcis_guard_append_only() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'bcis_immutable_row: % rows are insert-only', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION bcis_guard_invoice_items() RETURNS trigger AS $$
DECLARE parent_status text;
BEGIN
	SELECT status INTO parent_status FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
	-- A draft may be re-issued; a finalised invoice keeps its line items forever.
	IF parent_status IS DISTINCT FROM 'DRAFT' THEN
		RAISE EXCEPTION 'bcis_immutable_row: invoice line items are fixed once the invoice leaves DRAFT' USING ERRCODE = '23514';
	END IF;
	IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION bcis_guard_invoice_identity() RETURNS trigger AS $$
BEGIN
	IF (OLD.invoice_number, OLD.cycle_id, OLD.run_id, OLD.subscriber_id, OLD.service_account_id, OLD.source, OLD.period_label, OLD.issue_date, OLD.due_date, OLD.created_by, OLD.created_at)
		IS DISTINCT FROM
		(NEW.invoice_number, NEW.cycle_id, NEW.run_id, NEW.subscriber_id, NEW.service_account_id, NEW.source, NEW.period_label, NEW.issue_date, NEW.due_date, NEW.created_by, NEW.created_at) THEN
		RAISE EXCEPTION 'bcis_immutable_row: invoice identity and billing dates cannot be changed' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION bcis_guard_ledger_entry() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'bcis_immutable_row: ledger_entries rows are insert-only' USING ERRCODE = '23514';
	END IF;
	-- The running balance is the only derived column the rebuild may rewrite.
	IF (OLD.entry_no, OLD.subscriber_id, OLD.service_account_id, OLD.invoice_id, OLD.entry_date, OLD.reference_type, OLD.reference_id, OLD.reference_number, OLD.description, OLD.debit_centavos, OLD.credit_centavos, OLD.reversal_of_id, OLD.actor_id, OLD.created_at)
		IS DISTINCT FROM
		(NEW.entry_no, NEW.subscriber_id, NEW.service_account_id, NEW.invoice_id, NEW.entry_date, NEW.reference_type, NEW.reference_id, NEW.reference_number, NEW.description, NEW.debit_centavos, NEW.credit_centavos, NEW.reversal_of_id, NEW.actor_id, NEW.created_at) THEN
		RAISE EXCEPTION 'bcis_immutable_row: posted ledger amounts are append-only' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "invoice_items_append_only" BEFORE UPDATE OR DELETE ON "invoice_items" FOR EACH ROW EXECUTE FUNCTION bcis_guard_invoice_items();--> statement-breakpoint
CREATE TRIGGER "invoice_identity_immutable" BEFORE UPDATE ON "invoices" FOR EACH ROW EXECUTE FUNCTION bcis_guard_invoice_identity();--> statement-breakpoint
CREATE TRIGGER "adjustments_append_only" BEFORE UPDATE OR DELETE ON "adjustments" FOR EACH ROW EXECUTE FUNCTION bcis_guard_append_only();--> statement-breakpoint
CREATE TRIGGER "ledger_entries_append_only" BEFORE UPDATE OR DELETE ON "ledger_entries" FOR EACH ROW EXECUTE FUNCTION bcis_guard_ledger_entry();