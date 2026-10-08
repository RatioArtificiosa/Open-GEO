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

// Timestamps are stored as *text* (same column shape as the SQLite schema); see the note in
// pg/app.schema.ts. `isoNow` matches `new Date().toISOString()` so DB-defaulted and app-written
// values sort together lexicographically.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const timestampColumn = (name: string) => text(name);

/**
 * Postgres mirror of the SQLite `keyword_opportunity_inputs` table. See the SQLite definition for
 * the full rationale; the short version is that `score_model_version` is NOT NULL and sits in the
 * unique key, so a series that mixes two Opportunity Score models is unrepresentable rather than
 * merely discouraged, and the three inputs nothing captures yet are nullable so a missing
 * measurement is recorded as missing rather than as zero.
 *
 * `serp_competitors` is `bigint` here for the same reason ETV is: a SERP result count is unbounded
 * and can exceed what a 32-bit integer holds, and silently wrapping that would make an unmeasurable
 * keyword look like an easy one.
 */
export const keywordOpportunityInputs = pgTable(
  "keyword_opportunity_inputs",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull().default("en"),
    keywordDifficulty: integer("keyword_difficulty"),
    serpCompetitors: bigint("serp_competitors", { mode: "number" }),
    intent: text("intent"),
    aiNativeRatioBp: integer("ai_native_ratio_bp"),
    rankElasticityBp: integer("rank_elasticity_bp"),
    scoreModelVersion: text("score_model_version").notNull(),
    requestedAt: timestampColumn("requested_at").notNull(),
    capturedAt: timestampColumn("captured_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("keyword_opportunity_inputs_point_idx").on(
      table.projectId,
      table.keyword,
      table.locationCode,
      table.languageCode,
      table.scoreModelVersion,
      table.requestedAt,
    ),
    index("keyword_opportunity_inputs_series_idx").on(
      table.projectId,
      table.keyword,
      table.locationCode,
      table.capturedAt,
    ),
  ],
);
