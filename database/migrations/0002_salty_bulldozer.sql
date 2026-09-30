CREATE TABLE "collection_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "collection_areas_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "collectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"contact" text NOT NULL,
	"notes" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "collectors_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "master_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource" text NOT NULL,
	"record_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"reason" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_version" integer NOT NULL,
	"installation_address" text NOT NULL,
	"activation_date" date,
	"billing_start_date" date NOT NULL,
	"billing_day" integer NOT NULL,
	"due_day" integer NOT NULL,
	"current_rate_centavos" integer NOT NULL,
	"status" text NOT NULL,
	"area_id" uuid,
	"collector_id" uuid,
	"notes" text NOT NULL,
	CONSTRAINT "service_accounts_code_unique" UNIQUE("code"),
	CONSTRAINT "service_rate" CHECK ("service_accounts"."current_rate_centavos" >= 0),
	CONSTRAINT "service_days" CHECK ("service_accounts"."billing_day" BETWEEN 1 AND 31 AND "service_accounts"."due_day" BETWEEN 1 AND 31),
	CONSTRAINT "service_status" CHECK ("service_accounts"."status" IN ('PENDING','ACTIVE','INACTIVE','TERMINATED','ARCHIVED'))
);
--> statement-breakpoint
CREATE TABLE "service_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"service_type" text NOT NULL,
	"price_centavos" integer NOT NULL,
	"installation_fee_centavos" integer NOT NULL,
	"reconnection_fee_centavos" integer NOT NULL,
	"description" text NOT NULL,
	"speed_mbps" integer,
	"channel_count" integer,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "service_plans_code_unique" UNIQUE("code"),
	CONSTRAINT "plan_money_nonnegative" CHECK ("service_plans"."price_centavos" >= 0 AND "service_plans"."installation_fee_centavos" >= 0 AND "service_plans"."reconnection_fee_centavos" >= 0),
	CONSTRAINT "plan_type" CHECK ("service_plans"."service_type" IN ('INTERNET','CABLE','COMBO'))
);
--> statement-breakpoint
CREATE TABLE "subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"contact" text NOT NULL,
	"email" text NOT NULL,
	"addresses" jsonb NOT NULL,
	"area_id" uuid,
	"collector_id" uuid,
	"billing_day" integer NOT NULL,
	"due_day" integer NOT NULL,
	"status" text NOT NULL,
	"notes" text NOT NULL,
	CONSTRAINT "subscribers_code_unique" UNIQUE("code"),
	CONSTRAINT "subscriber_days" CHECK ("subscribers"."billing_day" BETWEEN 1 AND 31 AND "subscribers"."due_day" BETWEEN 1 AND 31),
	CONSTRAINT "subscriber_status" CHECK ("subscribers"."status" IN ('ACTIVE','INACTIVE','TERMINATED','ARCHIVED'))
);
--> statement-breakpoint
ALTER TABLE "master_history" ADD CONSTRAINT "master_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_plan_id_service_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."service_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_area_id_collection_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."collection_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_collector_id_collectors_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."collectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_area_id_collection_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."collection_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_collector_id_collectors_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."collectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "master_history_revision_idx" ON "master_history" USING btree ("resource","record_id","version");--> statement-breakpoint
CREATE INDEX "service_subscriber_idx" ON "service_accounts" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "service_plan_idx" ON "service_accounts" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "service_area_idx" ON "service_accounts" USING btree ("area_id");--> statement-breakpoint
CREATE INDEX "service_collector_idx" ON "service_accounts" USING btree ("collector_id");--> statement-breakpoint
CREATE INDEX "subscriber_name_idx" ON "subscribers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "subscriber_contact_idx" ON "subscribers" USING btree ("contact");--> statement-breakpoint
CREATE INDEX "subscriber_area_idx" ON "subscribers" USING btree ("area_id");--> statement-breakpoint
CREATE INDEX "subscriber_collector_idx" ON "subscribers" USING btree ("collector_id");
--> statement-breakpoint
UPDATE application_metadata SET value='3' WHERE key='schema_version';
