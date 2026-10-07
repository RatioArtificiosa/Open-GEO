-- The vendor category taxonomy: criterion ID to slash-path name (CL-406).
--
-- ## Why this migration is hand-written and numbered out of sequence
--
-- `pnpm db:generate` produced a file that bundled **four migrations' worth of changes** with this
-- one: `audit_readiness`, the two `audit_pages` columns, `geo_acquisition_mode`, and
-- `geo_snapshots.target_id`. The cause is that the Drizzle snapshot in `meta/` was four
-- migrations behind the SQL on disk — `0056_geo_snapshot_target`, `0057_geo_acquisition_mode`,
-- `0058_audit_page_headings` and `0059_audit_readiness` were hand-written without regenerating
-- it, which the journal shows (it ended at idx 57 while the directory held up to 0059).
--
-- **Applying that generated file would have failed on any database that already had those
-- objects** — which is every deployed one. So this file contains only what it says it contains,
-- and the two unregistered migrations are recorded in the journal alongside it so the next
-- `db:generate` diffs from an accurate base instead of colliding with `0058` again.
--
-- `criterion_id` is the vendor's own ID rather than a generated one, so re-running the seed
-- against a republished taxonomy lands on the same rows. See `scripts/seed-categories.ts`.
CREATE TABLE `category_taxonomy` (
	`criterion_id` integer PRIMARY KEY NOT NULL,
	`path` text NOT NULL
);
