-- The vendor category taxonomy (CL-406), plus two D1-only migrations that never reached Postgres.
--
-- ## The gap this closes
--
-- Postgres had **no migration for `audit_readiness`** and none for `audit_pages.headings_json` /
-- `schema_types_json`. The SQLite side has had both since `0059_audit_readiness` and
-- `0058_audit_page_headings`, but those were hand-written for D1 alone, so a **Postgres
-- self-host would fail at runtime the first time it ran an audit** — the table simply was not
-- there, while `src/db/pg/audit.schema.ts` declared it. A schema file and a migration chain that
-- disagree is invisible until someone deploys, which is why this is fixed here rather than noted.
--
-- ## Why the generated file was edited rather than committed
--
-- `pnpm db:generate` emitted those two objects **and** three statements that Postgres already
-- has — `geo_acquisition_mode`, `geo_snapshots.target_id` and its index, from migrations 0034 and
-- 0035. Re-applying them fails with a duplicate column. They were emitted because the Postgres
-- snapshot was also behind the Postgres files, for the same reason as on the D1 side.
--
-- So: everything the generated file added that Postgres genuinely lacks is kept, the three
-- already-applied statements are dropped, and this taxonomy table is appended. The snapshot in
-- `meta/0036_snapshot.json` models the full schema afterwards, so the next generate diffs
-- correctly.
CREATE TABLE "audit_readiness" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_id" text NOT NULL,
	"summary" text NOT NULL,
	"why_no_score" text NOT NULL,
	"fixes_json" text,
	"coverage_json" text,
	"unavailable_json" text,
	"fix_count" integer DEFAULT 0 NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "audit_readiness_audit_id_unique" UNIQUE("audit_id")
);
--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "headings_json" text;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "schema_types_json" text;--> statement-breakpoint
ALTER TABLE "audit_readiness" ADD CONSTRAINT "audit_readiness_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "category_taxonomy" (
	"criterion_id" integer PRIMARY KEY NOT NULL,
	"path" text NOT NULL
);
