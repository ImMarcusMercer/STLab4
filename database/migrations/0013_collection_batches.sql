CREATE TABLE "batch_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"subscriber_code" text NOT NULL,
	"subscriber_name" text NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"current_bill_centavos" integer NOT NULL,
	"arrears_centavos" integer NOT NULL,
	"total_due_centavos" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_account_total" CHECK ("batch_accounts"."total_due_centavos" = "batch_accounts"."current_bill_centavos" + "batch_accounts"."arrears_centavos"),
	CONSTRAINT "current_bill_centavos_nonnegative" CHECK ("batch_accounts"."current_bill_centavos" >= 0 AND "batch_accounts"."current_bill_centavos" <= 999999999),
	CONSTRAINT "arrears_centavos_nonnegative" CHECK ("batch_accounts"."arrears_centavos" >= 0 AND "batch_accounts"."arrears_centavos" <= 999999999),
	CONSTRAINT "total_due_centavos_nonnegative" CHECK ("batch_accounts"."total_due_centavos" >= 0 AND "batch_accounts"."total_due_centavos" <= 999999999)
);
--> statement-breakpoint
CREATE TABLE "batch_remittances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"remittance_number" text NOT NULL,
	"remitted_on" date NOT NULL,
	"expected_cash_centavos" integer NOT NULL,
	"cash_centavos" integer NOT NULL,
	"shortage_centavos" integer NOT NULL,
	"overage_centavos" integer NOT NULL,
	"balanced" boolean NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_remittances_remittance_number_unique" UNIQUE("remittance_number"),
	CONSTRAINT "remittance_number" CHECK ("batch_remittances"."remittance_number" ~ '^RMT-[0-9]{4}-[0-9]{4}$'),
	CONSTRAINT "remittance_variance" CHECK ("batch_remittances"."cash_centavos" - "batch_remittances"."expected_cash_centavos" = "batch_remittances"."overage_centavos" - "batch_remittances"."shortage_centavos"),
	CONSTRAINT "remittance_single_variance" CHECK (("batch_remittances"."shortage_centavos" = 0 OR "batch_remittances"."overage_centavos" = 0)),
	CONSTRAINT "remittance_balanced" CHECK ("batch_remittances"."balanced" = ("batch_remittances"."shortage_centavos" = 0 AND "batch_remittances"."overage_centavos" = 0)),
	CONSTRAINT "expected_cash_centavos_nonnegative" CHECK ("batch_remittances"."expected_cash_centavos" >= 0 AND "batch_remittances"."expected_cash_centavos" <= 999999999),
	CONSTRAINT "cash_centavos_nonnegative" CHECK ("batch_remittances"."cash_centavos" >= 0 AND "batch_remittances"."cash_centavos" <= 999999999),
	CONSTRAINT "shortage_centavos_nonnegative" CHECK ("batch_remittances"."shortage_centavos" >= 0 AND "batch_remittances"."shortage_centavos" <= 999999999),
	CONSTRAINT "overage_centavos_nonnegative" CHECK ("batch_remittances"."overage_centavos" >= 0 AND "batch_remittances"."overage_centavos" <= 999999999)
);
--> statement-breakpoint
CREATE TABLE "collection_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_number" text NOT NULL,
	"status" text NOT NULL,
	"collector_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"collection_date" date NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"remitted_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"reconciled_by" uuid,
	"reconciliation_notes" text DEFAULT '' NOT NULL,
	"closed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_batches_batch_number_unique" UNIQUE("batch_number"),
	CONSTRAINT "collection_batch_status" CHECK ("collection_batches"."status" IN ('OPEN','IN_PROGRESS','SUBMITTED','REMITTED','RECONCILED','CLOSED')),
	CONSTRAINT "collection_batch_number" CHECK ("collection_batches"."batch_number" ~ '^BCH-[0-9]{4}-[0-9]{4}$')
);
--> statement-breakpoint
ALTER TABLE "document_sequences" DROP CONSTRAINT "document_sequence_kind";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "collection_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "batch_accounts" ADD CONSTRAINT "batch_accounts_batch_id_collection_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."collection_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_accounts" ADD CONSTRAINT "batch_accounts_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_remittances" ADD CONSTRAINT "batch_remittances_batch_id_collection_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."collection_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_remittances" ADD CONSTRAINT "batch_remittances_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_batches" ADD CONSTRAINT "collection_batches_collector_id_collectors_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."collectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_batches" ADD CONSTRAINT "collection_batches_area_id_collection_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."collection_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_batches" ADD CONSTRAINT "collection_batches_reconciled_by_users_id_fk" FOREIGN KEY ("reconciled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_batches" ADD CONSTRAINT "collection_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "batch_accounts_batch_subscriber_idx" ON "batch_accounts" USING btree ("batch_id","subscriber_id");--> statement-breakpoint
CREATE INDEX "batch_accounts_batch_idx" ON "batch_accounts" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_remittances_batch_idx" ON "batch_remittances" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "collection_batches_status_idx" ON "collection_batches" USING btree ("status","collection_date");--> statement-breakpoint
CREATE INDEX "collection_batches_collector_idx" ON "collection_batches" USING btree ("collector_id","collection_date");--> statement-breakpoint
CREATE INDEX "collection_batches_area_idx" ON "collection_batches" USING btree ("area_id","collection_date");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_batches_route_idx" ON "collection_batches" USING btree ("collector_id","area_id","collection_date");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_collection_batch_id_collection_batches_id_fk" FOREIGN KEY ("collection_batch_id") REFERENCES "public"."collection_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_batch_idx" ON "payments" USING btree ("collection_batch_id","status");--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequence_kind" CHECK ("document_sequences"."kind" IN ('INVOICE','RECEIPT','BATCH','REMITTANCE'));
--> statement-breakpoint
-- Phase 6 guards.
-- The route a batch froze is written once and never changed, and a remittance is a count
-- that happened once, so both are refused on any update or delete. A batch moves one step
-- forward along the laboratory lifecycle and only inside a managed collection
-- transaction, so raw SQL can neither skip a step nor move a route backwards. The payment
-- identity now includes the batch, which means collected money can never be re-pointed at
-- a different sheet.
CREATE OR REPLACE FUNCTION bcis_guard_batch_state() RETURNS trigger AS $$
DECLARE
	managed boolean := coalesce(current_setting('bcis.collection', true), 'off') = 'on';
	step text;
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'bcis_immutable_row: a collection batch cannot be deleted, close it instead' USING ERRCODE = '23514';
	END IF;

	-- The route, the collector and the date are fixed when the batch is opened: a sheet that
	-- could be re-pointed afterwards would no longer be the sheet that was carried.
	IF ROW(OLD.batch_number, OLD.collector_id, OLD.area_id, OLD.collection_date, OLD.notes, OLD.created_by, OLD.created_at)
		IS DISTINCT FROM
		ROW(NEW.batch_number, NEW.collector_id, NEW.area_id, NEW.collection_date, NEW.notes, NEW.created_by, NEW.created_at) THEN
		RAISE EXCEPTION 'bcis_immutable_row: a collection batch cannot be edited, close it instead' USING ERRCODE = '23514';
	END IF;

	IF NOT managed AND ROW(OLD.status, OLD.started_at, OLD.submitted_at, OLD.remitted_at, OLD.reconciled_at, OLD.reconciled_by, OLD.reconciliation_notes, OLD.closed_at)
		IS DISTINCT FROM
		ROW(NEW.status, NEW.started_at, NEW.submitted_at, NEW.remitted_at, NEW.reconciled_at, NEW.reconciled_by, NEW.reconciliation_notes, NEW.closed_at) THEN
		RAISE EXCEPTION 'bcis_immutable_row: batch state is append-only, take the next lifecycle step instead' USING ERRCODE = '23514';
	END IF;

	-- Even inside a managed transaction the lifecycle is a straight line, so a batch can be
	-- opened, worked, submitted, remitted, reconciled and closed, and nothing else.
	IF OLD.status IS DISTINCT FROM NEW.status THEN
		step := CASE
			WHEN OLD.status = 'OPEN' AND NEW.status = 'IN_PROGRESS' THEN 'started'
			WHEN OLD.status = 'IN_PROGRESS' AND NEW.status = 'SUBMITTED' THEN 'submitted'
			WHEN OLD.status = 'SUBMITTED' AND NEW.status = 'REMITTED' THEN 'remitted'
			WHEN OLD.status = 'REMITTED' AND NEW.status = 'RECONCILED' THEN 'reconciled'
			WHEN OLD.status = 'RECONCILED' AND NEW.status = 'CLOSED' THEN 'closed'
			ELSE NULL
		END;
		IF step IS NULL THEN
			RAISE EXCEPTION 'bcis_invalid_transition: a collection batch cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bcis_guard_batch_accounts() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'bcis_immutable_row: the frozen route of a collection batch cannot be changed' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bcis_guard_batch_remittance() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'bcis_immutable_row: a remittance is a count that happened once and is kept for ever' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

-- Reconciliation is a second signature. The remittance must already exist, and the person
-- who counted the money may not be the person who accepts the count, so a shortage can never
-- be written off by the same hand that produced it.
CREATE OR REPLACE FUNCTION bcis_check_batch_reconciliation() RETURNS trigger AS $$
DECLARE
	recorder uuid;
BEGIN
	IF NEW.reconciled_by IS NULL THEN
		RETURN NULL;
	END IF;

	SELECT r.recorded_by INTO recorder FROM batch_remittances r WHERE r.batch_id = NEW.id;
	IF recorder IS NULL THEN
		RAISE EXCEPTION 'bcis_reconciliation_order: batch % can only be reconciled after its remittance was recorded', NEW.id USING ERRCODE = '23514';
	END IF;

	IF recorder = NEW.reconciled_by THEN
		RAISE EXCEPTION 'bcis_four_eyes: batch % must be reconciled by someone other than the person who recorded the remittance', NEW.id USING ERRCODE = '23514';
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bcis_guard_payment_history() RETURNS trigger AS $$
DECLARE
	posting boolean := coalesce(current_setting('bcis.posting', true), 'off') = 'on';
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'bcis_immutable_row: a payment cannot be deleted, void or reverse it instead' USING ERRCODE = '23514';
	END IF;

	-- The batch is part of the identity of the entry: collected money stays on the sheet it
	-- was collected for, so a batch total can never be restated by moving a payment.
	IF ROW(OLD.subscriber_id, OLD.method, OLD.direction, OLD.amount_centavos, OLD.received_on, OLD.reference_number, OLD.reversal_of_id, OLD.collection_batch_id, OLD.recorded_by, OLD.notes, OLD.created_at)
		IS DISTINCT FROM
		ROW(NEW.subscriber_id, NEW.method, NEW.direction, NEW.amount_centavos, NEW.received_on, NEW.reference_number, NEW.reversal_of_id, NEW.collection_batch_id, NEW.recorded_by, NEW.notes, NEW.created_at) THEN
		RAISE EXCEPTION 'bcis_immutable_row: a recorded payment cannot be edited, void or reverse it instead' USING ERRCODE = '23514';
	END IF;

	IF NOT posting AND ROW(OLD.status, OLD.receipt_number, OLD.reason, OLD.verified_by, OLD.verified_at, OLD.voided_at, OLD.void_reason)
		IS DISTINCT FROM
		ROW(NEW.status, NEW.receipt_number, NEW.reason, NEW.verified_by, NEW.verified_at, NEW.voided_at, NEW.void_reason) THEN
		RAISE EXCEPTION 'bcis_immutable_row: posted payment state is append-only, post a reversal instead' USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER collection_batches_state_guard BEFORE UPDATE OR DELETE ON collection_batches FOR EACH ROW EXECUTE FUNCTION bcis_guard_batch_state();
CREATE TRIGGER batch_accounts_immutable_guard BEFORE UPDATE OR DELETE ON batch_accounts FOR EACH ROW EXECUTE FUNCTION bcis_guard_batch_accounts();
CREATE TRIGGER batch_remittances_immutable_guard BEFORE UPDATE OR DELETE ON batch_remittances FOR EACH ROW EXECUTE FUNCTION bcis_guard_batch_remittance();
CREATE CONSTRAINT TRIGGER collection_batches_reconciliation_eyes AFTER UPDATE ON collection_batches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bcis_check_batch_reconciliation();
