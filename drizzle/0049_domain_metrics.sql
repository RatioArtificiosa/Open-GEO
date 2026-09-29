CREATE TABLE `domain_metrics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`domain` text NOT NULL,
	`location_code` integer NOT NULL,
	`language_code` text DEFAULT 'en' NOT NULL,
	`endpoint` text NOT NULL,
	`organic_etv` integer,
	`paid_etv` integer,
	`etv_formula_version` text NOT NULL,
	`etv_requested_at` text NOT NULL,
	`domain_rank` integer,
	`organic_keywords` integer,
	`paid_keywords` integer,
	`pages_count` integer,
	`captured_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_metrics_point_idx` ON `domain_metrics` (`project_id`,`domain`,`location_code`,`language_code`,`endpoint`,`etv_formula_version`,`etv_requested_at`);--> statement-breakpoint
CREATE INDEX `domain_metrics_series_idx` ON `domain_metrics` (`project_id`,`domain`,`location_code`,`endpoint`,`captured_at`);