CREATE TABLE "monitor_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"monitor_type" text NOT NULL,
	"monitor_subject" text DEFAULT '' NOT NULL,
	"platform" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"planned_items" integer,
	"completed_items" integer,
	"budget_usd" integer,
	"cost_usd_micros" integer,
	"charged_usd_micros" integer,
	"error_message" text,
	"started_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"completed_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitor_runs" ADD CONSTRAINT "monitor_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitor_runs_project_started_idx" ON "monitor_runs" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "monitor_runs_identity_idx" ON "monitor_runs" USING btree ("project_id","monitor_type","monitor_subject","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "monitor_runs_one_active_per_monitor_idx" ON "monitor_runs" USING btree ("project_id","monitor_type","monitor_subject","platform") WHERE "monitor_runs"."status" IN ('pending', 'running');