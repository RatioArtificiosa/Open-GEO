CREATE TABLE `monitor_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`monitor_type` text NOT NULL,
	`monitor_subject` text DEFAULT '' NOT NULL,
	`platform` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`planned_items` integer,
	`completed_items` integer,
	`budget_usd` integer,
	`cost_usd_micros` integer,
	`charged_usd_micros` integer,
	`error_message` text,
	`started_at` text DEFAULT (current_timestamp) NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `monitor_runs_project_started_idx` ON `monitor_runs` (`project_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `monitor_runs_identity_idx` ON `monitor_runs` (`project_id`,`monitor_type`,`monitor_subject`,`platform`);--> statement-breakpoint
CREATE UNIQUE INDEX `monitor_runs_one_active_per_monitor_idx` ON `monitor_runs` (`project_id`,`monitor_type`,`monitor_subject`,`platform`) WHERE "monitor_runs"."status" IN ('pending', 'running');