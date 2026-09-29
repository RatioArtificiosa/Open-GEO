CREATE TABLE "domain_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"domain" text NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text DEFAULT 'en' NOT NULL,
	"endpoint" text NOT NULL,
	"organic_etv" bigint,
	"paid_etv" bigint,
	"etv_formula_version" text NOT NULL,
	"etv_requested_at" text NOT NULL,
	"domain_rank" integer,
	"organic_keywords" bigint,
	"paid_keywords" bigint,
	"pages_count" integer,
	"captured_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain_metrics" ADD CONSTRAINT "domain_metrics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_metrics_point_idx" ON "domain_metrics" USING btree ("project_id","domain","location_code","language_code","endpoint","etv_formula_version","etv_requested_at");--> statement-breakpoint
CREATE INDEX "domain_metrics_series_idx" ON "domain_metrics" USING btree ("project_id","domain","location_code","endpoint","captured_at");