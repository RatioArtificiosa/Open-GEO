import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

// ============================================================================
// GEO — generative engine optimization (Postgres mirror of src/db/geo.schema.ts).
//
// Keep this file in lockstep with the SQLite one. `src/db/schema-parity.test.ts`
// enforces table set, columns, nullability, types, defaults, enums, PKs, unique
// and partial indexes, FKs and check-constraint names — but NOT the migration
// files. After editing here you must run `pnpm db:generate:pg` and commit the
// new drizzle-pg/ migration, or a Postgres deploy silently misses the change.
//
// Timestamps are stored as *text* (same column shape as SQLite); see the note in
// pg/app.schema.ts. `isoNow` matches `new Date().toISOString()` so DB-defaulted
// and app-written values sort together lexicographically.
//
// Design rationale for every table lives in the SQLite file; do not fork it.
// ============================================================================

/** The four AI answer platforms DataForSEO covers. */
const GEO_PLATFORMS = [
  "chat_gpt",
  "gemini",
  "perplexity",
  "google_ai_overview",
] as const;

const GEO_ANSWER_SOURCES = [
  "mentions_search",
  "llm_responses",
  "ai_mode",
] as const;

// Timestamps are stored as *text* (same column shape as the SQLite schema); see
// the note in pg/app.schema.ts. `isoNow` matches `new Date().toISOString()` so
// DB-defaulted and app-written values sort together lexicographically.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const geoTargets = pgTable(
  "geo_targets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    name: text("name").notNull(),
    aliases: text("aliases"),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("geo_targets_project_domain_location_language_idx").on(
      table.projectId,
      table.domain,
      table.locationCode,
      table.languageCode,
    ),
    index("geo_targets_project_idx").on(table.projectId),
  ],
);

export const geoPromptSets = pgTable(
  "geo_prompt_sets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("geo_prompt_sets_project_name_idx").on(
      table.projectId,
      table.name,
    ),
  ],
);

export const geoPrompts = pgTable(
  "geo_prompts",
  {
    id: text("id").primaryKey(),
    promptSetId: text("prompt_set_id")
      .notNull()
      .references(() => geoPromptSets.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    position: integer("position").notNull(),
    intent: text("intent", {
      enum: ["informational", "commercial", "transactional", "navigational"],
    }),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("geo_prompts_set_position_idx").on(
      table.promptSetId,
      table.position,
    ),
  ],
);

export const geoSnapshots = pgTable(
  "geo_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    promptSetId: text("prompt_set_id").references(() => geoPromptSets.id, {
      onDelete: "set null",
    }),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    costUsd: integer("cost_usd"),
    status: text("status", {
      enum: ["running", "complete", "failed", "cancelled"],
    })
      .notNull()
      .default("running"),
    createdBy: text("created_by", {
      enum: ["user", "sam", "mcp", "schedule"],
    }).notNull(),
  },
  (table) => [
    index("geo_snapshots_project_started_idx").on(
      table.projectId,
      table.startedAt,
    ),
  ],
);

export const geoAnswers = pgTable(
  "geo_answers",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    targetId: text("target_id").references(() => geoTargets.id, {
      onDelete: "cascade",
    }),
    promptSetId: text("prompt_set_id").references(() => geoPromptSets.id, {
      onDelete: "set null",
    }),
    prompt: text("prompt").notNull(),
    answerText: text("answer_text"),
    platform: text("platform", { enum: GEO_PLATFORMS }).notNull(),
    modelName: text("model_name"),
    source: text("source", { enum: GEO_ANSWER_SOURCES }).notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    answeredAt: text("answered_at").notNull(),
    vendorTaskId: text("vendor_task_id"),
    rawJson: text("raw_json"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    index("geo_answers_target_platform_answered_idx").on(
      table.targetId,
      table.platform,
      table.answeredAt,
    ),
    index("geo_answers_project_answered_idx").on(
      table.projectId,
      table.answeredAt,
    ),
    index("geo_answers_prompt_set_idx").on(table.promptSetId),
  ],
);

export const geoAnswerCitations = pgTable(
  "geo_answer_citations",
  {
    answerId: text("answer_id")
      .notNull()
      .references(() => geoAnswers.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    domain: text("domain"),
    title: text("title"),
    snippet: text("snippet"),
    rank: integer("rank"),
  },
  (table) => [
    primaryKey({ columns: [table.answerId, table.url] }),
    index("geo_answer_citations_domain_idx").on(table.domain),
  ],
);

export const geoAnswerRetrievals = pgTable(
  "geo_answer_retrievals",
  {
    answerId: text("answer_id")
      .notNull()
      .references(() => geoAnswers.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    domain: text("domain"),
    rank: integer("rank"),
  },
  (table) => [
    primaryKey({ columns: [table.answerId, table.url] }),
    index("geo_answer_retrievals_domain_idx").on(table.domain),
  ],
);

export const geoFanoutQueries = pgTable(
  "geo_fanout_queries",
  {
    answerId: text("answer_id")
      .notNull()
      .references(() => geoAnswers.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    position: integer("position").notNull(),
  },
  (table) => [primaryKey({ columns: [table.answerId, table.position] })],
);

export const geoSnapshotAnswers = pgTable(
  "geo_snapshot_answers",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => geoSnapshots.id, { onDelete: "cascade" }),
    answerId: text("answer_id")
      .notNull()
      .references(() => geoAnswers.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.snapshotId, table.answerId] })],
);

export const geoTargetMetrics = pgTable(
  "geo_target_metrics",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => geoTargets.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => geoSnapshots.id, { onDelete: "cascade" }),
    platform: text("platform", { enum: GEO_PLATFORMS }).notNull(),
    mentions: integer("mentions"),
    aiSearchVolume: integer("ai_search_volume"),
    capturedAt: text("captured_at").notNull(),
  },
  (table) => [
    uniqueIndex("geo_target_metrics_snapshot_target_platform_idx").on(
      table.snapshotId,
      table.targetId,
      table.platform,
    ),
    index("geo_target_metrics_target_platform_captured_idx").on(
      table.targetId,
      table.platform,
      table.capturedAt,
    ),
  ],
);

export const geoCitationDomains = pgTable(
  "geo_citation_domains",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => geoSnapshots.id, { onDelete: "cascade" }),
    platform: text("platform", { enum: GEO_PLATFORMS }).notNull(),
    domain: text("domain").notNull(),
    mentions: integer("mentions").notNull(),
    aiSearchVolume: integer("ai_search_volume"),
  },
  (table) => [
    primaryKey({
      columns: [table.snapshotId, table.platform, table.domain],
    }),
    index("geo_citation_domains_snapshot_platform_mentions_idx").on(
      table.snapshotId,
      table.platform,
      table.mentions,
    ),
  ],
);

export const aiKeywordMetrics = pgTable(
  "ai_keyword_metrics",
  {
    keyword: text("keyword").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    aiSearchVolume: integer("ai_search_volume"),
    month: text("month").notNull(),
    capturedAt: text("captured_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.projectId,
        table.keyword,
        table.locationCode,
        table.languageCode,
        table.month,
      ],
    }),
    index("ai_keyword_metrics_project_keyword_idx").on(
      table.projectId,
      table.keyword,
    ),
  ],
);

/**
 * Monthly mentions and demand for one monitored target.
 *
 * The `llm_mentions/historical` endpoint returns monthly aggregates only — there
 * is no `group_range` on it, so a daily reading is not available from that
 * source. The month is therefore part of the primary key, and a second capture of
 * the same month **upserts** rather than appends: the vendor revises history, and
 * a second row for the same month would make a chart double-count it.
 *
 * `platform` is in the key for the same reason it is in every other GEO key: two
 * platforms compute demand differently, and a row that blended them would be
 * unreadable rather than merely wrong.
 *
 * The two volume columns are nullable, and separately so. "No mentions recorded"
 * and "zero mentions recorded" are different facts, and collapsing them is how a
 * brand disappears from a chart without anyone being told.
 */
export const aiMentionHistory = pgTable(
  "ai_mention_history",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => geoTargets.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    /** `YYYY-MM`. The vendor sends year and month as two integers. */
    month: text("month").notNull(),
    mentions: integer("mentions"),
    aiSearchVolume: integer("ai_search_volume"),
    capturedAt: text("captured_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.projectId,
        table.targetId,
        table.platform,
        table.locationCode,
        table.languageCode,
        table.month,
      ],
    }),
    index("ai_mention_history_project_target_month_idx").on(
      table.projectId,
      table.targetId,
      table.month,
    ),
  ],
);

export const aiModeSnapshots = pgTable(
  "ai_mode_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    answerMarkdown: text("answer_markdown"),
    checkUrl: text("check_url"),
    capturedAt: text("captured_at").notNull(),
    rawJson: text("raw_json"),
  },
  (table) => [
    index("ai_mode_snapshots_project_keyword_captured_idx").on(
      table.projectId,
      table.keyword,
      table.capturedAt,
    ),
  ],
);

export const aiModeSnapshotCitations = pgTable(
  "ai_mode_snapshot_citations",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => aiModeSnapshots.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    domain: text("domain"),
    title: text("title"),
    snippet: text("snippet"),
  },
  (table) => [
    primaryKey({ columns: [table.snapshotId, table.url] }),
    index("ai_mode_snapshot_citations_snapshot_idx").on(table.snapshotId),
  ],
);
