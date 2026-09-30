CREATE TABLE `geo_pending_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`snapshot_id` text,
	`tag` text NOT NULL,
	`vendor_task_id` text NOT NULL,
	`se` text NOT NULL,
	`model_name` text NOT NULL,
	`prompt` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`advance_usd` integer,
	`settled_usd` integer,
	`error_message` text,
	`posted_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `geo_pending_tasks_pending_idx` ON `geo_pending_tasks` (`status`,`posted_at`);--> statement-breakpoint
CREATE INDEX `geo_pending_tasks_posted_idx` ON `geo_pending_tasks` (`posted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `geo_pending_tasks_vendor_task_idx` ON `geo_pending_tasks` (`vendor_task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `geo_pending_tasks_tag_idx` ON `geo_pending_tasks` (`project_id`,`tag`);