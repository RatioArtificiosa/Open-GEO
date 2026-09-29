CREATE TABLE `ai_mention_history` (
	`project_id` text NOT NULL,
	`target_id` text NOT NULL,
	`platform` text NOT NULL,
	`location_code` integer NOT NULL,
	`language_code` text NOT NULL,
	`month` text NOT NULL,
	`mentions` integer,
	`ai_search_volume` integer,
	`captured_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `target_id`, `platform`, `location_code`, `language_code`, `month`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `geo_targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_mention_history_project_target_month_idx` ON `ai_mention_history` (`project_id`,`target_id`,`month`);