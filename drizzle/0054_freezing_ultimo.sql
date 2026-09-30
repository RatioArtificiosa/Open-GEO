CREATE TABLE `geo_alert_dispatches` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`subject` text NOT NULL,
	`change_count` integer DEFAULT 0 NOT NULL,
	`detail` text,
	`dispatched_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `geo_alert_dispatches_project_idx` ON `geo_alert_dispatches` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `geo_alert_dispatches_run_idx` ON `geo_alert_dispatches` (`project_id`,`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `geo_alert_dispatches_sent_once_idx` ON `geo_alert_dispatches` (`project_id`,`fingerprint`) WHERE "geo_alert_dispatches"."status" = 'sent';