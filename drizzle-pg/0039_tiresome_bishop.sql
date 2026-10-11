CREATE TABLE "billing_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_by_user_id" text,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitor_runs" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "geo_pending_tasks" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "geo_alert_dispatches" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "billing_config" ADD CONSTRAINT "billing_config_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
