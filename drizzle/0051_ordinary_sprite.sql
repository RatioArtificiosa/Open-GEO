CREATE TABLE `geo_vendor_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`snapshot_id` text,
	`path` text NOT NULL,
	`request_body` text,
	`tag` text,
	`vendor_task_id` text,
	`response_body` text,
	`status_code` integer,
	`cost_usd` integer,
	`charged_usd` integer,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`snapshot_id`) REFERENCES `geo_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `geo_vendor_tasks_project_started_idx` ON `geo_vendor_tasks` (`project_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `geo_vendor_tasks_vendor_task_idx` ON `geo_vendor_tasks` (`vendor_task_id`);--> statement-breakpoint
CREATE INDEX `geo_vendor_tasks_snapshot_idx` ON `geo_vendor_tasks` (`snapshot_id`);