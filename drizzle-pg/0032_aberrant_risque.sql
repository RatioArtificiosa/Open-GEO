CREATE TABLE "geo_alert_dispatches" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"subject" text NOT NULL,
	"change_count" integer DEFAULT 0 NOT NULL,
	"detail" text,
	"dispatched_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_alert_dispatches" ADD CONSTRAINT "geo_alert_dispatches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "geo_alert_dispatches_project_idx" ON "geo_alert_dispatches" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "geo_alert_dispatches_run_idx" ON "geo_alert_dispatches" USING btree ("project_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_alert_dispatches_sent_once_idx" ON "geo_alert_dispatches" USING btree ("project_id","fingerprint") WHERE "geo_alert_dispatches"."status" = 'sent';