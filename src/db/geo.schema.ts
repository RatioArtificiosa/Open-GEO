import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";

// ============================================================================
// GEO — generative engine optimization.
//
// Shapes follow the real DataForSEO payloads (see src/server/lib/dataforseo/ai*.ts
// and its tests), not a guess, so no migration is needed once live data lands.
//
// The moat is the archive. A visibility score is a commodity; a stored corpus of
// "what the model actually said, to which prompt, citing whom" is the asset, and
// it is the only way to answer "why did this change?" after the fact.
//
// Two invariants, encoded in the schema rather than in a comment:
//
// 1. `platform` is part of the key and never aggregated. Google AI Overviews and
//    ChatGPT compute ai_search_volume differently (Google's is real search
//    volume; ChatGPT's is People-Also-Ask modelled). A column that could hold a
//    blended total is a column someone will eventually blend.
//
// 2. Retrieval and citation are separate tables, not one nullable column. The
//    gap between them is the most valuable output of the product, and a nullable
//    flag in a single table is exactly how that gets lost.
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

/**
 * A tracked brand. Deliberately not the project row: a project holds the
 * commercial relationship, this holds the thing being measured, and a brand can
 * be monitored under several projects.
 */
export const geoTargets = sqliteTable(
  "geo_targets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Normalized bare host (lowercase, no protocol/www) so the same brand added
    // from two surfaces lands on one row.
    domain: text("domain").notNull(),
    name: text("name").notNull(),
    /** Brands are often wider than a domain ("Acme" vs acme.com). */
    aliases: text("aliases"),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    // Platform is deliberately absent: a brand is tracked across all platforms,
    // not as one row per platform.
    uniqueIndex("geo_targets_project_domain_location_language_idx").on(
      table.projectId,
      table.domain,
      table.locationCode,
      table.languageCode,
    ),
    index("geo_targets_project_idx").on(table.projectId),
  ],
);

/** A reusable prompt set. Patrols run against a set, so it is versioned apart. */
export const geoPromptSets = sqliteTable(
  "geo_prompt_sets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    uniqueIndex("geo_prompt_sets_project_name_idx").on(
      table.projectId,
      table.name,
    ),
  ],
);

/** One prompt. `position` preserves the curated order the set was built with. */
export const geoPrompts = sqliteTable(
  "geo_prompts",
  {
    id: text("id").primaryKey(),
    promptSetId: text("prompt_set_id")
      .notNull()
      .references(() => geoPromptSets.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    position: integer("position").notNull(),
    /** Cached classification, so the recommender doesn't re-derive it. */
    intent: text("intent", {
      enum: ["informational", "commercial", "transactional", "navigational"],
    }),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    uniqueIndex("geo_prompts_set_position_idx").on(
      table.promptSetId,
      table.position,
    ),
  ],
);

/**
 * A monitoring run. The unit that makes history possible: without a run id a
 * series has no anchor and "what changed?" cannot be answered.
 *
 * Declared before the tables that reference it so the relationship reads in
 * dependency order.
 */
export const geoSnapshots = sqliteTable(
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
    /**
     * **How many prompts this run asked — the denominator for every rate we
     * publish about it.**
     *
     * A mention rate is `mentions / asked`, and `asked` is the term that decides
     * whether a rate means anything. "Mentioned in 4 answers" and "mentioned in
     * 4 of 40 answers" are the same sentence and different facts: 4/4 is perfect
     * visibility on a sample too small to have meant it, and reporting it as 100%
     * is the failure this product exists to prevent. Without this column the
     * forecast had a numerator and no denominator, and the only way to produce a
     * rate was to guess a sample — which *narrows* the confidence band and makes
     * a weakly-measured run look like a well-measured one. The guess flatters the
     * number, which is why it is not an acceptable fallback.
     *
     * Nullable, and null is a real state rather than a gap to fill:
     *
     * - `null` — the run cannot say what it asked. A **queued** run posts prompts
     *   to a vendor queue and archives nothing, so at the moment the snapshot is
     *   written no prompt has been answered; any number here would be a plan, not
     *   a measurement.
     * - `0` — the run asked and got nothing back. Distinct from null: zero is
     *   measured absence, null is an absence of measurement.
     *
     * The two are not interchangeable and collapsing them is how a run that
     * failed gets rendered as a run that found nothing.
     */
    promptsAsked: integer("prompts_asked"),
    /** Vendor cost in USD, so budget reporting reads from the archive. */
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

/**
 * One stored AI answer. The archive.
 *
 * `answerText` is kept VERBATIM, never paraphrased or summarized: the only
 * useful output of this table is a diff against a previous run, and a paraphrase
 * destroys the ability to diff. The exact prompt is stored alongside it because
 * an answer without its prompt is not reproducible evidence.
 */
export const geoAnswers = sqliteTable(
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
    /** The exact question asked, as sent. */
    prompt: text("prompt").notNull(),
    /** Verbatim answer text. Do not transform. */
    answerText: text("answer_text"),
    platform: text("platform", { enum: GEO_PLATFORMS }).notNull(),
    /** The model as it actually answered, which may differ from what we asked. */
    modelName: text("model_name"),
    source: text("source", { enum: GEO_ANSWER_SOURCES }).notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    /** Vendor timestamp of the answer, UTC. */
    answeredAt: text("answered_at").notNull(),
    /**
     * The DataForSEO task id. Lets a later run re-fetch the same record after the
     * vendor changes retention, and is the only way to reconcile a billing dispute.
     */
    vendorTaskId: text("vendor_task_id"),
    /** Raw vendor response, so a schema change never loses archived evidence. */
    rawJson: text("raw_json"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    // The diff read: every answer for a target+platform over time.
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

/**
 * Pages an answer CITED. The composite primary key de-duplicates by URL, so
 * re-running a prompt cannot inflate a citation count — the failure mode that
 * makes every "share of voice" number quietly wrong.
 */
export const geoAnswerCitations = sqliteTable(
  "geo_answer_citations",
  {
    answerId: text("answer_id")
      .notNull()
      .references(() => geoAnswers.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    domain: text("domain"),
    title: text("title"),
    /** Snippet the model was given, where the vendor returns one. */
    snippet: text("snippet"),
    /** Vendor-supplied rank within the citation list, when present. */
    rank: integer("rank"),
  },
  (table) => [
    primaryKey({ columns: [table.answerId, table.url] }),
    // "Which pages of mine get cited?" — the most common GEO query.
    index("geo_answer_citations_domain_idx").on(table.domain),
  ],
);

/**
 * Pages an answer RETRIEVED but did not cite.
 *
 * ChatGPT only. DataForSEO does not return Google's retrieval list, so this
 * table has no google_ai_overview rows — that absence is the finding, and it is
 * why the platform column must never be aggregated.
 */
export const geoAnswerRetrievals = sqliteTable(
  "geo_answer_retrievals",
  {
    answerId: text("answer_id")
      .notNull()
      .references(() => geoAnswers.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    domain: text("domain"),
    /** Position in the retrieved set, which need not match citation order. */
    rank: integer("rank"),
  },
  (table) => [
    primaryKey({ columns: [table.answerId, table.url] }),
    index("geo_answer_retrievals_domain_idx").on(table.domain),
  ],
);

/**
 * The queries a model expanded a single prompt into, when it did.
 *
 * Optional in the payload and not proof that web search ran — the gotchas doc
 * says so explicitly — so it is stored when present and never inferred.
 */
export const geoFanoutQueries = sqliteTable(
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

/** Which answers belong to which run. */
export const geoSnapshotAnswers = sqliteTable(
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

/**
 * Per-target rollups per run, per platform. One row per
 * (snapshot, target, platform) — never a row spanning two platforms.
 */
export const geoTargetMetrics = sqliteTable(
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
    /**
     * The platform's own demand model. NOT comparable across platforms and NOT
     * summable with a sibling row — see the file header.
     */
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

/** Domains cited across a snapshot, for share-of-voice without re-scanning. */
export const geoCitationDomains = sqliteTable(
  "geo_citation_domains",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => geoSnapshots.id, { onDelete: "cascade" }),
    platform: text("platform", { enum: GEO_PLATFORMS }).notNull(),
    domain: text("domain").notNull(),
    mentions: integer("mentions").notNull(),
    /** Same non-comparability caveat as geo_target_metrics.ai_search_volume. */
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

/**
 * AI demand for a keyword, per market. Separate from Google search volume and
 * never merged with it: a topic with high AI demand and low Google demand is the
 * signal this product exists to surface.
 *
 * `aiSearchVolume` is nullable because a null and a zero mean different things —
 * "no data" versus "no recorded demand" — and collapsing them corrupts the series.
 */
export const aiKeywordMetrics = sqliteTable(
  "ai_keyword_metrics",
  {
    keyword: text("keyword").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    aiSearchVolume: integer("ai_search_volume"),
    /** YYYY-MM, so a series sorts and gaps stay visible. */
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
export const aiMentionHistory = sqliteTable(
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

/**
 * Google AI Mode snapshots, kept apart from geo_answers because the payload is a
 * different shape (elements, tables, shopping) and the unit of change is the
 * whole answer, not one citation. `answerMarkdown` is verbatim for the same
 * reason: the diff is the product.
 */
export const aiModeSnapshots = sqliteTable(
  "ai_mode_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    /** Verbatim AI Mode markdown. Do not transform. */
    answerMarkdown: text("answer_markdown"),
    /** Reproducible link to the exact SERP we were shown. */
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

/** Citations attached to an AI Mode snapshot. */
export const aiModeSnapshotCitations = sqliteTable(
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
