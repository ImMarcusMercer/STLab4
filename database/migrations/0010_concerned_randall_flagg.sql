CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"source" text NOT NULL,
	"amount_centavos" integer NOT NULL,
	"reversed_at" timestamp with time zone,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocation_source" CHECK ("payment_allocations"."source" IN ('PAYMENT','ADVANCE')),
	CONSTRAINT "payment_allocation_positive" CHECK ("payment_allocations"."amount_centavos" >= 1),
	CONSTRAINT "amount_centavos_nonnegative" CHECK ("payment_allocations"."amount_centavos" >= 0 AND "payment_allocations"."amount_centavos" <= 999999999)
);
--> statement-breakpoint
CREATE TABLE "payment_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"original_name" text NOT NULL,
	"stored_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_proofs_stored_name_unique" UNIQUE("stored_name"),
	CONSTRAINT "payment_proof_mime_type" CHECK ("payment_proofs"."mime_type" IN ('image/png','image/jpeg','application/pdf')),
	CONSTRAINT "payment_proof_byte_size" CHECK ("payment_proofs"."byte_size" >= 1 AND "payment_proofs"."byte_size" <= 5242880),
	CONSTRAINT "payment_proof_digest" CHECK ("payment_proofs"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "payment_proof_stored_name" CHECK ("payment_proofs"."stored_name" ~ '^[a-f0-9-]{36}\.(png|jpg|pdf)$')
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_number" text,
	"subscriber_id" uuid NOT NULL,
	"method" text NOT NULL,
	"direction" text DEFAULT 'PAYMENT' NOT NULL,
	"status" text NOT NULL,
	"amount_centavos" integer NOT NULL,
	"received_on" date NOT NULL,
	"reference_number" text,
	"notes" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"reversal_of_id" uuid,
	"recorded_by" uuid NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_receipt_number_unique" UNIQUE("receipt_number"),
	CONSTRAINT "payment_method" CHECK ("payments"."method" IN ('CASH','GCASH')),
	CONSTRAINT "payment_status" CHECK ("payments"."status" IN ('PENDING','POSTED','VOID','REVERSED')),
	CONSTRAINT "payment_direction" CHECK ("payments"."direction" IN ('PAYMENT','REVERSAL')),
	CONSTRAINT "payment_reference" CHECK ("payments"."direction" = 'REVERSAL' OR ("payments"."method" = 'GCASH' AND length("payments"."reference_number") > 0) OR ("payments"."method" = 'CASH' AND "payments"."reference_number" IS NULL)),
	CONSTRAINT "payment_pairing" CHECK (("payments"."direction" = 'PAYMENT' AND "payments"."reversal_of_id" IS NULL) OR ("payments"."direction" = 'REVERSAL' AND "payments"."reversal_of_id" IS NOT NULL AND length("payments"."reason") > 0)),
	CONSTRAINT "payment_state" CHECK (("payments"."status" = 'PENDING' AND "payments"."receipt_number" IS NULL AND "payments"."voided_at" IS NULL AND "payments"."method" = 'GCASH' AND "payments"."direction" = 'PAYMENT')
    OR ("payments"."status" = 'POSTED' AND "payments"."receipt_number" IS NOT NULL AND "payments"."voided_at" IS NULL AND ("payments"."method" = 'CASH' OR "payments"."verified_at" IS NOT NULL) AND ("payments"."direction" = 'PAYMENT' OR "payments"."reversal_of_id" IS NOT NULL))
    OR ("payments"."status" = 'VOID' AND "payments"."voided_at" IS NOT NULL AND length("payments"."void_reason") > 0)
    OR ("payments"."status" = 'REVERSED' AND "payments"."voided_at" IS NOT NULL AND length("payments"."void_reason") > 0 AND "payments"."direction" = 'PAYMENT')),
	CONSTRAINT "amount_centavos_nonnegative" CHECK ("payments"."amount_centavos" >= 0 AND "payments"."amount_centavos" <= 999999999)
);
--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proofs" ADD CONSTRAINT "payment_proofs_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reversal_of_id_payments_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocation_invoice_idx" ON "payment_allocations" USING btree ("payment_id","invoice_id");--> statement-breakpoint
CREATE INDEX "payment_allocation_payment_idx" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_allocation_invoice_lookup_idx" ON "payment_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payments_subscriber_idx" ON "payments" USING btree ("subscriber_id","received_on");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status","received_on");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_gcash_reference_idx" ON "payments" USING btree ("reference_number") WHERE "payments"."method" = 'GCASH' AND "payments"."status" <> 'VOID';