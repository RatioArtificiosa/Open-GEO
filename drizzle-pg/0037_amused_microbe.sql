CREATE TABLE "keyword_opportunity_inputs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"keyword" text NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text DEFAULT 'en' NOT NULL,
	"keyword_difficulty" integer,
	"serp_competitors" bigint,
	"intent" text,
	"ai_native_ratio_bp" integer,
	"rank_elasticity_bp" integer,
	"score_model_version" text NOT NULL,
	"requested_at" text NOT NULL,
	"captured_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "keyword_opportunity_inputs" ADD CONSTRAINT "keyword_opportunity_inputs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "keyword_opportunity_inputs_point_idx" ON "keyword_opportunity_inputs" USING btree ("project_id","keyword","location_code","language_code","score_model_version","requested_at");--> statement-breakpoint
CREATE INDEX "keyword_opportunity_inputs_series_idx" ON "keyword_opportunity_inputs" USING btree ("project_id","keyword","location_code","captured_at");