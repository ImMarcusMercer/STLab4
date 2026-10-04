CREATE TABLE "backup_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"row_counts" jsonb NOT NULL,
	"attachment_count" integer NOT NULL,
	"attachment_bytes" integer NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"restored_at" timestamp with time zone,
	"restored_by" uuid,
	CONSTRAINT "backup_history_file_name_unique" UNIQUE("file_name"),
	CONSTRAINT "backup_kind" CHECK ("backup_history"."kind" IN ('FULL','DATABASE')),
	CONSTRAINT "backup_status" CHECK ("backup_history"."status" IN ('COMPLETED','FAILED')),
	CONSTRAINT "backup_file_name" CHECK ("backup_history"."file_name" ~ '^[a-f0-9-]{36}\.dump$'),
	CONSTRAINT "backup_digest" CHECK ("backup_history"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "backup_byte_size" CHECK ("backup_history"."byte_size" >= 0),
	CONSTRAINT "backup_note" CHECK (char_length("backup_history"."note") <= 200),
	CONSTRAINT "backup_failure_reason" CHECK (char_length("backup_history"."failure_reason") <= 400)
);
--> statement-breakpoint
ALTER TABLE "backup_history" ADD CONSTRAINT "backup_history_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_history" ADD CONSTRAINT "backup_history_restored_by_users_id_fk" FOREIGN KEY ("restored_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_history_created_idx" ON "backup_history" USING btree ("created_at");