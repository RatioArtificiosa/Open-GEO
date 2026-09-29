CREATE TABLE "geo_vendor_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"snapshot_id" text,
	"path" text NOT NULL,
	"request_body" text,
	"tag" text,
	"vendor_task_id" text,
	"response_body" text,
	"status_code" integer,
	"cost_usd" integer,
	"charged_usd" integer,
	"started_at" text NOT NULL,
	"completed_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_vendor_tasks" ADD CONSTRAINT "geo_vendor_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_vendor_tasks" ADD CONSTRAINT "geo_vendor_tasks_snapshot_id_geo_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."geo_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "geo_vendor_tasks_project_started_idx" ON "geo_vendor_tasks" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "geo_vendor_tasks_vendor_task_idx" ON "geo_vendor_tasks" USING btree ("vendor_task_id");--> statement-breakpoint
CREATE INDEX "geo_vendor_tasks_snapshot_idx" ON "geo_vendor_tasks" USING btree ("snapshot_id");