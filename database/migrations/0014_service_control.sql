CREATE TABLE "reconnections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reconnection_number" text NOT NULL,
	"service_account_id" uuid NOT NULL,
	"suspension_id" uuid,
	"status" text NOT NULL,
	"fee_centavos" integer NOT NULL,
	"requested_by" uuid NOT NULL,
	"technician_id" uuid,
	"notes" text DEFAULT '' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "reconnections_reconnection_number_unique" UNIQUE("reconnection_number"),
	CONSTRAINT "reconnection_number" CHECK ("reconnections"."reconnection_number" ~ '^RCO-[0-9]{4}-[0-9]{4}$'),
	CONSTRAINT "reconnection_status" CHECK ("reconnections"."status" IN ('REQUESTED','ASSIGNED','COMPLETED','CANCELLED')),
	CONSTRAINT "fee_centavos_nonnegative" CHECK ("reconnections"."fee_centavos" >= 0 AND "reconnections"."fee_centavos" <= 999999999)
);
--> statement-breakpoint
CREATE TABLE "service_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grace_period_days" integer NOT NULL,
	"suspension_threshold_centavos" integer NOT NULL,
	"auto_suspend" boolean DEFAULT false NOT NULL,
	"reconnection_fee_centavos" integer NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suspension_threshold_centavos_nonnegative" CHECK ("service_policy"."suspension_threshold_centavos" >= 0 AND "service_policy"."suspension_threshold_centavos" <= 999999999),
	CONSTRAINT "reconnection_fee_centavos_nonnegative" CHECK ("service_policy"."reconnection_fee_centavos" >= 0 AND "service_policy"."reconnection_fee_centavos" <= 999999999),
	CONSTRAINT "policy_grace" CHECK ("service_policy"."grace_period_days" BETWEEN 0 AND 365)
);
--> statement-breakpoint
CREATE TABLE "suspensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suspension_number" text NOT NULL,
	"service_account_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"effective_date" date NOT NULL,
	"grace_period_days" integer NOT NULL,
	"threshold_centavos" integer NOT NULL,
	"arrears_at_suspension_centavos" integer NOT NULL,
	"months_unpaid_at_suspension" integer NOT NULL,
	"approved_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid,
	CONSTRAINT "suspensions_suspension_number_unique" UNIQUE("suspension_number"),
	CONSTRAINT "suspension_number" CHECK ("suspensions"."suspension_number" ~ '^SUS-[0-9]{4}-[0-9]{4}$'),
	CONSTRAINT "suspension_status" CHECK ("suspensions"."status" IN ('ACTIVE','LIFTED','CANCELLED')),
	CONSTRAINT "threshold_centavos_nonnegative" CHECK ("suspensions"."threshold_centavos" >= 0 AND "suspensions"."threshold_centavos" <= 999999999),
	CONSTRAINT "arrears_at_suspension_centavos_nonnegative" CHECK ("suspensions"."arrears_at_suspension_centavos" >= 0 AND "suspensions"."arrears_at_suspension_centavos" <= 999999999),
	CONSTRAINT "suspension_grace" CHECK ("suspensions"."grace_period_days" BETWEEN 0 AND 365),
	CONSTRAINT "suspension_months" CHECK ("suspensions"."months_unpaid_at_suspension" >= 0)
);
--> statement-breakpoint
ALTER TABLE "document_sequences" DROP CONSTRAINT "document_sequence_kind";--> statement-breakpoint
ALTER TABLE "document_sequences" DROP CONSTRAINT "document_sequence_start";--> statement-breakpoint
ALTER TABLE "reconnections" ADD CONSTRAINT "reconnections_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconnections" ADD CONSTRAINT "reconnections_suspension_id_suspensions_id_fk" FOREIGN KEY ("suspension_id") REFERENCES "public"."suspensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconnections" ADD CONSTRAINT "reconnections_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconnections" ADD CONSTRAINT "reconnections_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_policy" ADD CONSTRAINT "service_policy_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspensions" ADD CONSTRAINT "suspensions_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspensions" ADD CONSTRAINT "suspensions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspensions" ADD CONSTRAINT "suspensions_lifted_by_users_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconnections_service_idx" ON "reconnections" USING btree ("service_account_id");--> statement-breakpoint
CREATE INDEX "reconnections_status_idx" ON "reconnections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reconnections_suspension_idx" ON "reconnections" USING btree ("suspension_id");--> statement-breakpoint
CREATE INDEX "suspensions_service_idx" ON "suspensions" USING btree ("service_account_id");--> statement-breakpoint
CREATE INDEX "suspensions_status_idx" ON "suspensions" USING btree ("status");--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "sequence_kind" CHECK ("document_sequences"."kind" IN ('INVOICE','RECEIPT','BATCH','REMITTANCE','SUSPENSION','RECONNECTION'));--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "sequence_year" CHECK ("document_sequences"."year" BETWEEN 2000 AND 2100);--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "sequence_value" CHECK ("document_sequences"."next_value" >= 1001);