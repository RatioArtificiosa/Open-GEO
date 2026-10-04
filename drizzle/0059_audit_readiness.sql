CREATE TABLE `audit_readiness` (
	`id` text PRIMARY KEY NOT NULL,
	`audit_id` text NOT NULL,
	`summary` text NOT NULL,
	`why_no_score` text NOT NULL,
	`coverage_json` text,
	`unavailable_json` text,
	`fix_count` integer DEFAULT 0 NOT NULL,
	`page_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_readiness_audit_id_idx` ON `audit_readiness` (`audit_id`);