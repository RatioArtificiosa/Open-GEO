import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  pgTable,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

// Timestamps are stored as *text* (same column shape as the SQLite schema); see
// the note in pg/app.schema.ts. `isoNow` matches `new Date().toISOString()` so
// DB-defaulted and app-written values sort together lexicographically.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const timestampColumn = (name: string) => text(name);

/**
 * Postgres mirror of the SQLite `domain_metrics` table. See the SQLite
 * definition for the full rationale; the short version is that
 * `etv_formula_version` is NOT NULL and sits in the unique key, so a series that
 * mixes the pre- and post-2026-11-01 ETV models is unrepresentable rather than
 * merely discouraged.
 *
 * `etv_requested_at` is when WE asked, distinct from `captured_at` (when the
 * vendor answered). They differ when a response is re-read from cache.
 */
export const domainMetrics = pgTable(
  "domain_metrics",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull().default("en"),
    endpoint: text("endpoint", {
      enum: ["domain_rank_overview", "ranked_keywords", "relevant_pages"],
    }).notNull(),
    // --- ETV, always versioned -------------------------------------------
    organicEtv: bigint("organic_etv", { mode: "number" }),
    paidEtv: bigint("paid_etv", { mode: "number" }),
    etvFormulaVersion: text("etv_formula_version", {
      enum: ["legacy", "new"],
    }).notNull(),
    etvRequestedAt: timestampColumn("etv_requested_at").notNull(),
    // --- Non-ETV metrics, unaffected by the formula change ----------------
    domainRank: integer("domain_rank"),
    organicKeywords: bigint("organic_keywords", { mode: "number" }),
    paidKeywords: bigint("paid_keywords", { mode: "number" }),
    pagesCount: integer("pages_count"),
    capturedAt: timestampColumn("captured_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("domain_metrics_point_idx").on(
      table.projectId,
      table.domain,
      table.locationCode,
      table.languageCode,
      table.endpoint,
      table.etvFormulaVersion,
      table.etvRequestedAt,
    ),
    index("domain_metrics_series_idx").on(
      table.projectId,
      table.domain,
      table.locationCode,
      table.endpoint,
      table.capturedAt,
    ),
  ],
);
