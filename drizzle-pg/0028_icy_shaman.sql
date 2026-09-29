CREATE TABLE "ai_mention_history" (
	"project_id" text NOT NULL,
	"target_id" text NOT NULL,
	"platform" text NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"month" text NOT NULL,
	"mentions" integer,
	"ai_search_volume" integer,
	"captured_at" text NOT NULL,
	CONSTRAINT "ai_mention_history_project_id_target_id_platform_location_code_language_code_month_pk" PRIMARY KEY("project_id","target_id","platform","location_code","language_code","month")
);
--> statement-breakpoint
ALTER TABLE "ai_mention_history" ADD CONSTRAINT "ai_mention_history_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_mention_history" ADD CONSTRAINT "ai_mention_history_target_id_geo_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."geo_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_mention_history_project_target_month_idx" ON "ai_mention_history" USING btree ("project_id","target_id","month");