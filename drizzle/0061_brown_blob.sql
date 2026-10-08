CREATE TABLE `keyword_opportunity_inputs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`keyword` text NOT NULL,
	`location_code` integer NOT NULL,
	`language_code` text DEFAULT 'en' NOT NULL,
	`keyword_difficulty` integer,
	`serp_competitors` integer,
	`intent` text,
	`ai_native_ratio_bp` integer,
	`rank_elasticity_bp` integer,
	`score_model_version` text NOT NULL,
	`requested_at` text NOT NULL,
	`captured_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `keyword_opportunity_inputs_point_idx` ON `keyword_opportunity_inputs` (`project_id`,`keyword`,`location_code`,`language_code`,`score_model_version`,`requested_at`);--> statement-breakpoint
CREATE INDEX `keyword_opportunity_inputs_series_idx` ON `keyword_opportunity_inputs` (`project_id`,`keyword`,`location_code`,`captured_at`);