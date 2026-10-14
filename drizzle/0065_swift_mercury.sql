-- Forecast snapshots now name the brand they are about.
--
-- `0064` created the table with a key of (project, kind, subject, model, day). That
-- key is wrong for a project monitoring more than one brand: `geo_targets` is one row
-- per (project, domain, market) and the patrol runs once per target, so two brands in
-- one project produce the *same* key for the same platform on the same night. The
-- second insert then collides and is silently dropped by `onConflictDoNothing` — one
-- brand's forecast disappears while the sweep reports having written it — and a reader
-- measuring one domain reads back the other brand's row.
--
-- **The column is added with a default so the rows can be reconstructed rather than
-- discarded, and the reconstruction is per-kind because the kinds know different
-- things about themselves:**
--
-- 1. `citation_win` rows already carry the brand: the sweep wrote `subject = domain`
--    for that kind, so it is a copy rather than an inference.
-- 2. `visibility_forecast` and `visibility_pace` rows are attributed to the project's
--    single monitored brand, where the project has exactly one. **One brand, not one
--    row:** `geo_targets` is unique on (project, domain, market), so a project watching
--    one domain in two markets has two target rows and one brand — which is why the
--    count is `DISTINCT domain` rather than `COUNT(*)`.
--
--    **The subquery is wrapped in COALESCE, and that is load-bearing rather than
--    defensive.** A scalar subquery that finds nothing yields NULL in both dialects, so
--    an UPDATE assigning it straight into a NOT NULL column *fails the migration* — an
--    archived project, or one whose targets are all archived, would abort the whole
--    batch. COALESCE turns "nothing found" into the empty string the next statement
--    already deletes, which is what makes the batch complete and lets the delete
--    decide, rather than a constraint error deciding.
-- 3. Rows belonging to a project with two or more brands are deleted. The brand was
--    *never recorded* for these — that is the defect — so any value here would be
--    fabricated, and fabricated attribution is the exact failure `geo_snapshots
--    .target_id` refused a backfill for in `0056`. Deleting the row is honest; the
--    forecast is recomputed by the very next nightly sweep from the archive that is
--    still there, so nothing is lost that cannot be written again.
--
-- The archive the sweep reads is untouched: `geo_snapshots`, `geo_answers`,
-- `geo_answers_citations` and `geoTargets` all keep every row, which is what makes the
-- recomputation claim above true rather than convenient.
--
-- The default on the new column is a scaffold for this migration only. The application
-- refuses an empty domain on write, so no row can ever carry one from the app; it
-- exists so `UPDATE` has something to match against before the delete below.

ALTER TABLE `geo_forecast_snapshots` ADD `domain` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `geo_forecast_snapshots` SET `domain` = `subject` WHERE `kind` = 'citation_win';--> statement-breakpoint
-- **`MIN(t.domain)`, not a bare `t.domain`.** SQLite tolerates a bare column in a
-- grouped query and returns a row's value; **Postgres rejects it outright** with "must
-- appear in the GROUP BY clause or be used in an aggregate function", which would have
-- made the pg dialect of this migration fail to run at all. The aggregate is not a
-- workaround for the difference: `HAVING COUNT(DISTINCT domain) = 1` already
-- guarantees every value in the group is the same one, so MIN returns the only value
-- there is. It is also what makes the scalar query return **exactly one row** in every
-- case, which is what the assignment relies on.
UPDATE `geo_forecast_snapshots` SET `domain` = COALESCE((
	SELECT MIN(`t`.`domain`) FROM `geo_targets` `t`
	INNER JOIN `projects` `p` ON `p`.`id` = `t`.`project_id`
	WHERE `t`.`project_id` = `geo_forecast_snapshots`.`project_id`
		AND `p`.`archived_at` IS NULL
	GROUP BY `t`.`project_id`
	HAVING COUNT(DISTINCT `t`.`domain`) = 1
	LIMIT 1
), '')
WHERE `domain` = ''
	AND `kind` IN ('visibility_forecast', 'visibility_pace');--> statement-breakpoint
-- Whatever is left is genuinely unattributable, and the reason is stated rather than
-- implied: a row that cannot name its brand is not readable evidence.
DELETE FROM `geo_forecast_snapshots` WHERE `domain` = '';--> statement-breakpoint
DROP INDEX `geo_forecast_snapshots_point_idx`;--> statement-breakpoint
DROP INDEX `geo_forecast_snapshots_series_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `geo_forecast_snapshots_point_idx` ON `geo_forecast_snapshots` (`project_id`,`kind`,`domain`,`subject`,`model_version`,`issued_on`);--> statement-breakpoint
CREATE INDEX `geo_forecast_snapshots_series_idx` ON `geo_forecast_snapshots` (`project_id`,`kind`,`domain`,`subject`,`issued_on`);
