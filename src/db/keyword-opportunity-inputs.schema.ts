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
 * Keyword opportunity inputs over time, one row per (project, keyword, market, model version,
 * request time).
 *
 * ## Why this table exists
 *
 * `CL-503`'s forecast job is *"backed by nightly jobs over stored history"* — and three of the
 * Opportunity Score's five inputs (`keyword_difficulty`, `serp_competitors`, `intent`) are stored
 * nowhere. Without them the job would compute from empty tables and store confident scores derived
 * from absence, which is exactly the failure `scheduledEtvCapture` opens by describing: a chart that
 * *has had no data since it was built*, wearing a provenance stamp that made it look careful. This
 * is the writer those inputs never had.
 *
 * ## The three columns that are nullable on purpose
 *
 * `keyword_difficulty`, `serp_competitors` and `intent` are **nullable, and a `null` means "we did
 * not have it" rather than "it is zero"** — the same position the rest of this codebase takes, and
 * the reason `competitorEase(0)` refuses to read missing data as an advantage. **A row that records
 * what was absent is more useful than a table that pretends the field does not exist:** it
 * distinguishes a keyword we measured and found easy from one we never measured.
 *
 * ## Why the model version is NOT NULL and in the key
 *
 * `score_model_version` follows `etv_formula_version` exactly: an unstamped score is unreadable the
 * moment the weights change, so we refuse to store one rather than store something we would later
 * have to caveat. And it sits **in the unique index**, so a series that mixes two model versions is
 * *unrepresentable* rather than merely discouraged.
 *
 * `requested_at` is when we asked, distinct from `captured_at` (when the vendor answered). They
 * differ when a response is re-read from cache, and that difference is what a reproducibility
 * dispute turns on.
 *
 * Postgres mirror: `src/db/pg/keyword-opportunity-inputs.schema.ts`.
 */
export const keywordOpportunityInputs = sqliteTable(
  "keyword_opportunity_inputs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The keyword as submitted, lowercased and trimmed so a series cannot fork on casing. */
    keyword: text("keyword").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull().default("en"),
    // --- The three inputs that are not yet captured anywhere -------------------
    /** 0–100 as the vendor reports it. Null means unmeasured, never "not difficult". */
    keywordDifficulty: integer("keyword_difficulty"),
    /** Result count for the SERP. Null is a gap: `competitorEase(0)` scores it lowest, not best. */
    serpCompetitors: integer("serp_competitors"),
    /** `informational | commercial | transactional | navigational`, as classified by the vendor. */
    intent: text("intent"),
    // --- The two the existing captures can already supply ---------------------
    /** Share of the SERP that is AI-native, 0–1 scaled to 0–10000 to stay integer. */
    aiNativeRatioBp: integer("ai_native_ratio_bp"),
    /** How much rank moves per unit of effort, 0–1 scaled to 0–10000 to stay integer. */
    rankElasticityBp: integer("rank_elasticity_bp"),
    // --- Provenance -----------------------------------------------------------
    /**
     * Which Opportunity Score model these inputs were captured for. NOT NULL by design: an unstamped
     * row is unreadable after the weights change, so we refuse to store it.
     */
    scoreModelVersion: text("score_model_version").notNull(),
    /** When we asked the vendor, as opposed to when it answered. */
    requestedAt: text("requested_at").notNull(),
    capturedAt: text("captured_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    // One measurement per (target, market, model, request time). The model and the request time are
    // IN the key on purpose, so a series spanning two models is unrepresentable.
    uniqueIndex("keyword_opportunity_inputs_point_idx").on(
      table.projectId,
      table.keyword,
      table.locationCode,
      table.languageCode,
      table.scoreModelVersion,
      table.requestedAt,
    ),
    // The read the forecast job makes: one project's keywords over time.
    index("keyword_opportunity_inputs_series_idx").on(
      table.projectId,
      table.keyword,
      table.locationCode,
      table.capturedAt,
    ),
  ],
);
