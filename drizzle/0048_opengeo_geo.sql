CREATE TABLE `ai_keyword_metrics` (
	`keyword` text NOT NULL,
	`project_id` text NOT NULL,
	`location_code` integer NOT NULL,
	`language_code` text NOT NULL,
	`ai_search_volume` integer,
	`month` text NOT NULL,
	`captured_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `keyword`, `location_code`, `language_code`, `month`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_keyword_metrics_project_keyword_idx` ON `ai_keyword_metrics` (`project_id`,`keyword`);--> statement-breakpoint
CREATE TABLE `ai_mode_snapshot_citations` (
	`snapshot_id` text NOT NULL,
	`url` text NOT NULL,
	`domain` text,
	`title` text,
	`snippet` text,
	PRIMARY KEY(`snapshot_id`, `url`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `ai_mode_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_mode_snapshot_citations_snapshot_idx` ON `ai_mode_snapshot_citations` (`snapshot_id`);--> statement-breakpoint
CREATE TABLE `ai_mode_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`keyword` text NOT NULL,
	`location_code` integer NOT NULL,
	`language_code` text NOT NULL,
	`answer_markdown` text,
	`check_url` text,
	`captured_at` text NOT NULL,
	`raw_json` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_mode_snapshots_project_keyword_captured_idx` ON `ai_mode_snapshots` (`project_id`,`keyword`,`captured_at`);--> statement-breakpoint
CREATE TABLE `geo_answer_citations` (
	`answer_id` text NOT NULL,
	`url` text NOT NULL,
	`domain` text,
	`title` text,
	`snippet` text,
	`rank` integer,
	PRIMARY KEY(`answer_id`, `url`),
	FOREIGN KEY (`answer_id`) REFERENCES `geo_answers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `geo_answer_citations_domain_idx` ON `geo_answer_citations` (`domain`);--> statement-breakpoint
CREATE TABLE `geo_answer_retrievals` (
	`answer_id` text NOT NULL,
	`url` text NOT NULL,
	`domain` text,
	`rank` integer,
	PRIMARY KEY(`answer_id`, `url`),
	FOREIGN KEY (`answer_id`) REFERENCES `geo_answers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `geo_answer_retrievals_domain_idx` ON `geo_answer_retrievals` (`domain`);--> statement-breakpoint
CREATE TABLE `geo_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`target_id` text,
	`prompt_set_id` text,
	`prompt` text NOT NULL,
	`answer_text` text,
	`platform` text NOT NULL,
	`model_name` text,
	`source` text NOT NULL,
	`location_code` integer NOT NULL,
	`language_code` text NOT NULL,
	`answered_at` text NOT NULL,
	`vendor_task_id` text,
	`raw_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `geo_targets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prompt_set_id`) REFERENCES `geo_prompt_sets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `geo_answers_target_platform_answered_idx` ON `geo_answers` (`target_id`,`platform`,`answered_at`);--> statement-breakpoint
CREATE INDEX `geo_answers_project_answered_idx` ON `geo_answers` (`project_id`,`answered_at`);--> statement-breakpoint
CREATE INDEX `geo_answers_prompt_set_idx` ON `geo_answers` (`prompt_set_id`);--> statement-breakpoint
CREATE TABLE `geo_citation_domains` (
	`snapshot_id` text NOT NULL,
	`platform` text NOT NULL,
	`domain` text NOT NULL,
	`mentions` integer NOT NULL,
	`ai_search_volume` integer,
	PRIMARY KEY(`snapshot_id`, `platform`, `domain`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `geo_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `geo_citation_domains_snapshot_platform_mentions_idx` ON `geo_citation_domains` (`snapshot_id`,`platform`,`mentions`);--> statement-breakpoint
CREATE TABLE `geo_fanout_queries` (
	`answer_id` text NOT NULL,
	`query` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`answer_id`, `position`),
	FOREIGN KEY (`answer_id`) REFERENCES `geo_answers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `geo_prompt_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `geo_prompt_sets_project_name_idx` ON `geo_prompt_sets` (`project_id`,`name`);--> statement-breakpoint
CREATE TABLE `geo_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`prompt_set_id` text NOT NULL,
	`prompt` text NOT NULL,
	`position` integer NOT NULL,
	`intent` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`prompt_set_id`) REFERENCES `geo_prompt_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `geo_prompts_set_position_idx` ON `geo_prompts` (`prompt_set_id`,`position`);--> statement-breakpoint
CREATE TABLE `geo_snapshot_answers` (
	`snapshot_id` text NOT NULL,
	`answer_id` text NOT NULL,
	PRIMARY KEY(`snapshot_id`, `answer_id`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `geo_snapshots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`answer_id`) REFERENCES `geo_answers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `geo_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`prompt_set_id` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`cost_usd` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prompt_set_id`) REFERENCES `geo_prompt_sets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `geo_snapshots_project_started_idx` ON `geo_snapshots` (`project_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `geo_target_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`target_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`platform` text NOT NULL,
	`mentions` integer,
	`ai_search_volume` integer,
	`captured_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `geo_targets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`snapshot_id`) REFERENCES `geo_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `geo_target_metrics_snapshot_target_platform_idx` ON `geo_target_metrics` (`snapshot_id`,`target_id`,`platform`);--> statement-breakpoint
CREATE INDEX `geo_target_metrics_target_platform_captured_idx` ON `geo_target_metrics` (`target_id`,`platform`,`captured_at`);--> statement-breakpoint
CREATE TABLE `geo_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`domain` text NOT NULL,
	`name` text NOT NULL,
	`aliases` text,
	`location_code` integer NOT NULL,
	`language_code` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `geo_targets_project_domain_location_language_idx` ON `geo_targets` (`project_id`,`domain`,`location_code`,`language_code`);--> statement-breakpoint
CREATE INDEX `geo_targets_project_idx` ON `geo_targets` (`project_id`);