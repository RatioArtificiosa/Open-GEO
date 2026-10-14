CREATE TABLE "geo_forecast_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"model_version" text NOT NULL,
	"issued_on" text NOT NULL,
	"horizon_days" integer NOT NULL,
	"share_bp" integer,
	"low_bp" integer,
	"high_bp" integer,
	"per_week_bp" integer,
	"now_bp" integer,
	"based_on" integer NOT NULL,
	"based_on_weeks" integer,
	"confidence" text,
	"note" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_forecast_snapshots" ADD CONSTRAINT "geo_forecast_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "geo_forecast_snapshots_point_idx" ON "geo_forecast_snapshots" USING btree ("project_id","kind","subject","model_version","issued_on");--> statement-breakpoint
CREATE INDEX "geo_forecast_snapshots_series_idx" ON "geo_forecast_snapshots" USING btree ("project_id","kind","subject","issued_on");--> statement-breakpoint
CREATE INDEX "geo_forecast_snapshots_project_idx" ON "geo_forecast_snapshots" USING btree ("project_id","issued_on");