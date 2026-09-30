CREATE TABLE "geo_pending_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"snapshot_id" text,
	"tag" text NOT NULL,
	"vendor_task_id" text NOT NULL,
	"se" text NOT NULL,
	"model_name" text NOT NULL,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"advance_usd" integer,
	"settled_usd" integer,
	"error_message" text,
	"posted_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
ALTER TABLE "geo_pending_tasks" ADD CONSTRAINT "geo_pending_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "geo_pending_tasks_pending_idx" ON "geo_pending_tasks" USING btree ("status","posted_at");--> statement-breakpoint
CREATE INDEX "geo_pending_tasks_posted_idx" ON "geo_pending_tasks" USING btree ("posted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_pending_tasks_vendor_task_idx" ON "geo_pending_tasks" USING btree ("vendor_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_pending_tasks_tag_idx" ON "geo_pending_tasks" USING btree ("project_id","tag");