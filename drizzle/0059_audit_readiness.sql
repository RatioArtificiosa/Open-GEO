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
-- **Unique, not a plain index.** The row id is already derived from the audit id, so
-- uniqueness is implied — but implied by a convention three files away, and this is
-- where it stops being a habit and becomes a guarantee.
CREATE UNIQUE INDEX `audit_readiness_audit_id_idx` ON `audit_readiness` (`audit_id`);