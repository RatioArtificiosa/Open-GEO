CREATE TABLE `geo_forecast_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`model_version` text NOT NULL,
	`issued_on` text NOT NULL,
	`horizon_days` integer NOT NULL,
	`share_bp` integer,
	`low_bp` integer,
	`high_bp` integer,
	`per_week_bp` integer,
	`now_bp` integer,
	`based_on` integer NOT NULL,
	`based_on_weeks` integer,
	`confidence` text,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `geo_forecast_snapshots_point_idx` ON `geo_forecast_snapshots` (`project_id`,`kind`,`subject`,`model_version`,`issued_on`);--> statement-breakpoint
CREATE INDEX `geo_forecast_snapshots_series_idx` ON `geo_forecast_snapshots` (`project_id`,`kind`,`subject`,`issued_on`);--> statement-breakpoint
CREATE INDEX `geo_forecast_snapshots_project_idx` ON `geo_forecast_snapshots` (`project_id`,`issued_on`);