import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";

/**
 * Domain-level Labs metrics over time, one row per (project, domain, market,
 * endpoint, formula version, request time).
 *
 * This table is why `etv_formula_version` is mandatory rather than nice to have.
 * The fork never persisted ETV at all — `domain_rank_overview`,
 * `ranked_keywords` and `relevant_pages` were R2-cached with a 12-hour TTL and
 * nothing survived a day. That is fine for a lookup and useless for a trend,
 * which is the whole product. The moment we start writing ETV down, a formula
 * change on 2026-11-01 would silently bend every historical line, because
 * nothing would record which model produced each point.
 *
 * So the version and the request time are part of the row's identity, and
 * `etv_formula_version` is NOT NULL. A row whose provenance we do not know is
 * not a row we are willing to store.
 *
 * `etv_requested_at` is when *we* asked, distinct from `captured_at` (when the
 * vendor served it). They differ when a response is re-read from cache, and that
 * difference is exactly what a reproducibility dispute turns on.
 *
 * Postgres mirror: `src/db/pg/domain-metrics.schema.ts`.
 */
export const domainMetrics = sqliteTable(
  "domain_metrics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Normalized bare host, lowercase, no protocol or www. */
    domain: text("domain").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull().default("en"),
    /** Which Labs endpoint produced this row, so a series is never mixed. */
    endpoint: text("endpoint", {
      enum: ["domain_rank_overview", "ranked_keywords", "relevant_pages"],
    }).notNull(),
    // --- ETV, always versioned -------------------------------------------
    /** Estimated organic traffic. A model, not a measurement. */
    organicEtv: integer("organic_etv"),
    paidEtv: integer("paid_etv"),
    /**
     * Which ETV model produced the figures above. NOT NULL by design: an
     * unstamped value is unreadable after 2026-11-01, so we refuse to store it
     * rather than store something we will later have to caveat.
     */
    etvFormulaVersion: text("etv_formula_version", {
      enum: ["legacy", "new"],
    }).notNull(),
    /** When we asked the vendor, as opposed to when it answered. */
    etvRequestedAt: text("etv_requested_at").notNull(),
    // --- Non-ETV metrics, unaffected by the formula change ----------------
    domainRank: integer("domain_rank"),
    organicKeywords: integer("organic_keywords"),
    paidKeywords: integer("paid_keywords"),
    /** The vendor's own page count for the SERP, when it returns one. */
    pagesCount: integer("pages_count"),
    capturedAt: text("captured_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    // One figure per (target, market, endpoint, model, request time). The model
    // and the request time are IN the key on purpose: it makes a mixed-formula
    // series unrepresentable rather than merely discouraged.
    uniqueIndex("domain_metrics_point_idx").on(
      table.projectId,
      table.domain,
      table.locationCode,
      table.languageCode,
      table.endpoint,
      table.etvFormulaVersion,
      table.etvRequestedAt,
    ),
    // The series read: one target+market+endpoint over time.
    index("domain_metrics_series_idx").on(
      table.projectId,
      table.domain,
      table.locationCode,
      table.endpoint,
      table.capturedAt,
    ),
  ],
);
