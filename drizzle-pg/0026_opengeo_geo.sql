CREATE TABLE "ai_keyword_metrics" (
	"keyword" text NOT NULL,
	"project_id" text NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"ai_search_volume" integer,
	"month" text NOT NULL,
	"captured_at" text NOT NULL,
	CONSTRAINT "ai_keyword_metrics_project_id_keyword_location_code_language_code_month_pk" PRIMARY KEY("project_id","keyword","location_code","language_code","month")
);
--> statement-breakpoint
CREATE TABLE "ai_mode_snapshot_citations" (
	"snapshot_id" text NOT NULL,
	"url" text NOT NULL,
	"domain" text,
	"title" text,
	"snippet" text,
	CONSTRAINT "ai_mode_snapshot_citations_snapshot_id_url_pk" PRIMARY KEY("snapshot_id","url")
);
--> statement-breakpoint
CREATE TABLE "ai_mode_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"keyword" text NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"answer_markdown" text,
	"check_url" text,
	"captured_at" text NOT NULL,
	"raw_json" text
);
--> statement-breakpoint
CREATE TABLE "geo_answer_citations" (
	"answer_id" text NOT NULL,
	"url" text NOT NULL,
	"domain" text,
	"title" text,
	"snippet" text,
	"rank" integer,
	CONSTRAINT "geo_answer_citations_answer_id_url_pk" PRIMARY KEY("answer_id","url")
);
--> statement-breakpoint
CREATE TABLE "geo_answer_retrievals" (
	"answer_id" text NOT NULL,
	"url" text NOT NULL,
	"domain" text,
	"rank" integer,
	CONSTRAINT "geo_answer_retrievals_answer_id_url_pk" PRIMARY KEY("answer_id","url")
);
--> statement-breakpoint
CREATE TABLE "geo_answers" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"target_id" text,
	"prompt_set_id" text,
	"prompt" text NOT NULL,
	"answer_text" text,
	"platform" text NOT NULL,
	"model_name" text,
	"source" text NOT NULL,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"answered_at" text NOT NULL,
	"vendor_task_id" text,
	"raw_json" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo_citation_domains" (
	"snapshot_id" text NOT NULL,
	"platform" text NOT NULL,
	"domain" text NOT NULL,
	"mentions" integer NOT NULL,
	"ai_search_volume" integer,
	CONSTRAINT "geo_citation_domains_snapshot_id_platform_domain_pk" PRIMARY KEY("snapshot_id","platform","domain")
);
--> statement-breakpoint
CREATE TABLE "geo_fanout_queries" (
	"answer_id" text NOT NULL,
	"query" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "geo_fanout_queries_answer_id_position_pk" PRIMARY KEY("answer_id","position")
);
--> statement-breakpoint
CREATE TABLE "geo_prompt_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo_prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"prompt_set_id" text NOT NULL,
	"prompt" text NOT NULL,
	"position" integer NOT NULL,
	"intent" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo_snapshot_answers" (
	"snapshot_id" text NOT NULL,
	"answer_id" text NOT NULL,
	CONSTRAINT "geo_snapshot_answers_snapshot_id_answer_id_pk" PRIMARY KEY("snapshot_id","answer_id")
);
--> statement-breakpoint
CREATE TABLE "geo_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"prompt_set_id" text,
	"started_at" text NOT NULL,
	"completed_at" text,
	"cost_usd" integer,
	"status" text DEFAULT 'running' NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo_target_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"target_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"platform" text NOT NULL,
	"mentions" integer,
	"ai_search_volume" integer,
	"captured_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"domain" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_keyword_metrics" ADD CONSTRAINT "ai_keyword_metrics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_mode_snapshot_citations" ADD CONSTRAINT "ai_mode_snapshot_citations_snapshot_id_ai_mode_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."ai_mode_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_mode_snapshots" ADD CONSTRAINT "ai_mode_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_answer_citations" ADD CONSTRAINT "geo_answer_citations_answer_id_geo_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."geo_answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_answer_retrievals" ADD CONSTRAINT "geo_answer_retrievals_answer_id_geo_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."geo_answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_answers" ADD CONSTRAINT "geo_answers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_answers" ADD CONSTRAINT "geo_answers_target_id_geo_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."geo_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_answers" ADD CONSTRAINT "geo_answers_prompt_set_id_geo_prompt_sets_id_fk" FOREIGN KEY ("prompt_set_id") REFERENCES "public"."geo_prompt_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_citation_domains" ADD CONSTRAINT "geo_citation_domains_snapshot_id_geo_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."geo_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_fanout_queries" ADD CONSTRAINT "geo_fanout_queries_answer_id_geo_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."geo_answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_prompt_sets" ADD CONSTRAINT "geo_prompt_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_prompts" ADD CONSTRAINT "geo_prompts_prompt_set_id_geo_prompt_sets_id_fk" FOREIGN KEY ("prompt_set_id") REFERENCES "public"."geo_prompt_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_snapshot_answers" ADD CONSTRAINT "geo_snapshot_answers_snapshot_id_geo_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."geo_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_snapshot_answers" ADD CONSTRAINT "geo_snapshot_answers_answer_id_geo_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."geo_answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_snapshots" ADD CONSTRAINT "geo_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_snapshots" ADD CONSTRAINT "geo_snapshots_prompt_set_id_geo_prompt_sets_id_fk" FOREIGN KEY ("prompt_set_id") REFERENCES "public"."geo_prompt_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_target_metrics" ADD CONSTRAINT "geo_target_metrics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_target_metrics" ADD CONSTRAINT "geo_target_metrics_target_id_geo_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."geo_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_target_metrics" ADD CONSTRAINT "geo_target_metrics_snapshot_id_geo_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."geo_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_targets" ADD CONSTRAINT "geo_targets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_keyword_metrics_project_keyword_idx" ON "ai_keyword_metrics" USING btree ("project_id","keyword");--> statement-breakpoint
CREATE INDEX "ai_mode_snapshot_citations_snapshot_idx" ON "ai_mode_snapshot_citations" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "ai_mode_snapshots_project_keyword_captured_idx" ON "ai_mode_snapshots" USING btree ("project_id","keyword","captured_at");--> statement-breakpoint
CREATE INDEX "geo_answer_citations_domain_idx" ON "geo_answer_citations" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "geo_answer_retrievals_domain_idx" ON "geo_answer_retrievals" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "geo_answers_target_platform_answered_idx" ON "geo_answers" USING btree ("target_id","platform","answered_at");--> statement-breakpoint
CREATE INDEX "geo_answers_project_answered_idx" ON "geo_answers" USING btree ("project_id","answered_at");--> statement-breakpoint
CREATE INDEX "geo_answers_prompt_set_idx" ON "geo_answers" USING btree ("prompt_set_id");--> statement-breakpoint
CREATE INDEX "geo_citation_domains_snapshot_platform_mentions_idx" ON "geo_citation_domains" USING btree ("snapshot_id","platform","mentions");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_prompt_sets_project_name_idx" ON "geo_prompt_sets" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_prompts_set_position_idx" ON "geo_prompts" USING btree ("prompt_set_id","position");--> statement-breakpoint
CREATE INDEX "geo_snapshots_project_started_idx" ON "geo_snapshots" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_target_metrics_snapshot_target_platform_idx" ON "geo_target_metrics" USING btree ("snapshot_id","target_id","platform");--> statement-breakpoint
CREATE INDEX "geo_target_metrics_target_platform_captured_idx" ON "geo_target_metrics" USING btree ("target_id","platform","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_targets_project_domain_location_language_idx" ON "geo_targets" USING btree ("project_id","domain","location_code","language_code");--> statement-breakpoint
CREATE INDEX "geo_targets_project_idx" ON "geo_targets" USING btree ("project_id");