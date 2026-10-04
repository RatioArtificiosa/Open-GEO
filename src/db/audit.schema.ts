import {
  sqliteTable,
  text,
  integer,
  real,
  index,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { PAGE_FETCH_CLASSES } from "@/shared/audit-fetch-class";
import { projects } from "./app.schema";

// ============================================================================
// Site Audit tables
// ============================================================================

// One row per audit run
export const audits = sqliteTable(
  "audits",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    startedByUserId: text("started_by_user_id").notNull(),
    startUrl: text("start_url").notNull(),
    status: text("status", {
      enum: ["running", "completed", "failed"],
    })
      .notNull()
      .default("running"),
    workflowInstanceId: text("workflow_instance_id"),
    // JSON config: { maxPages, lighthouseStrategy }
    config: text("config").notNull().default("{}"),
    // Progress & summary
    pagesCrawled: integer("pages_crawled").notNull().default(0),
    pagesTotal: integer("pages_total").notNull().default(0),
    lighthouseTotal: integer("lighthouse_total").notNull().default(0),
    lighthouseCompleted: integer("lighthouse_completed").notNull().default(0),
    lighthouseFailed: integer("lighthouse_failed").notNull().default(0),
    currentPhase: text("current_phase").default("discovery"),
    // Failure diagnostics; null unless status = "failed". errorCode is a
    // closed vocabulary (see classifyAuditError) so failures are aggregable;
    // errorDetail is the raw message, truncated. failedPhase records which
    // currentPhase the audit was in when it died.
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    failedPhase: text("failed_phase"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("audits_project_id_idx").on(table.projectId),
    index("audits_started_by_user_id_idx").on(table.startedByUserId),
  ],
);

// One row per crawled page
export const auditPages = sqliteTable(
  "audit_pages",
  {
    id: text("id").primaryKey(),
    auditId: text("audit_id")
      .notNull()
      .references(() => audits.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    statusCode: integer("status_code"),
    redirectUrl: text("redirect_url"),
    // Metadata
    title: text("title"),
    metaDescription: text("meta_description"),
    canonicalUrl: text("canonical_url"),
    robotsMeta: text("robots_meta"),
    // Open Graph
    ogTitle: text("og_title"),
    ogDescription: text("og_description"),
    ogImage: text("og_image"),
    // Headings
    h1Count: integer("h1_count").notNull().default(0),
    h2Count: integer("h2_count").notNull().default(0),
    h3Count: integer("h3_count").notNull().default(0),
    h4Count: integer("h4_count").notNull().default(0),
    h5Count: integer("h5_count").notNull().default(0),
    h6Count: integer("h6_count").notNull().default(0),
    headingOrderJson: text("heading_order_json"),
    /**
     * Heading **text** with its level, as JSON.
     *
     * **Added because the citability rubric asks what a heading said and this
     * column only ever held its level.** `heading_order_json` answers "how many
     * headings, in what order"; it cannot answer "does this page lead with an
     * answer" or "what fraction of subheadings are questions", which is the whole
     * of the answer-first and question-headers factors.
     *
     * Null rather than `'[]'` for a page that was never analysed, because *no
     * headings found* is a finding and *not analysed* is a gap, and the report
     * scores them differently.
     */
    headingsJson: text("headings_json"),
    // Content
    wordCount: integer("word_count").notNull().default(0),
    // Images
    imagesTotal: integer("images_total").notNull().default(0),
    imagesMissingAlt: integer("images_missing_alt").notNull().default(0),
    imagesJson: text("images_json"),
    // Links
    internalLinkCount: integer("internal_link_count").notNull().default(0),
    externalLinkCount: integer("external_link_count").notNull().default(0),
    // Structured data
    hasStructuredData: integer("has_structured_data", { mode: "boolean" })
      .notNull()
      .default(false),
    /**
     * The schema.org `@type` names the page declares, as JSON.
     *
     * **`hasStructuredData` says a block exists; this says what it declares**, and
     * the citability rubric's schema-coverage factor needs the second — "this page
     * declares itself an Article" is a finding, "this page has a JSON-LD script" is
     * not one.
     *
     * Null when the page was never analysed. An empty array is a real answer: the
     * page was parsed and declared nothing.
     */
    schemaTypesJson: text("schema_types_json"),
    // Hreflang
    hreflangTagsJson: text("hreflang_tags_json"),
    // Indexability
    isIndexable: integer("is_indexable", { mode: "boolean" })
      .notNull()
      .default(true),
    // Indexability/canonical signals from response headers
    xRobotsTag: text("x_robots_tag"),
    headerCanonicalUrl: text("header_canonical_url"),
    // Crawl metadata
    // null depth = not reached via links (e.g. sitemap-seeded)
    crawlDepth: integer("crawl_depth"),
    inSitemap: integer("in_sitemap", { mode: "boolean" })
      .notNull()
      .default(false),
    // SHA-256 of the visible body text, for duplicate-content grouping
    contentHash: text("content_hash"),
    fetchClass: text("fetch_class", { enum: PAGE_FETCH_CLASSES })
      .notNull()
      .default("ok"),
    // Performance
    responseTimeMs: integer("response_time_ms"),
  },
  (table) => [index("audit_pages_audit_url_idx").on(table.auditId, table.url)],
);

// Link edges live in the per-audit AuditScratchpad Durable Object for the
// duration of the crawl; they are never persisted to the app DB.

// One row per (issue type, affected page)
export const auditIssues = sqliteTable(
  "audit_issues",
  {
    id: text("id").primaryKey(),
    auditId: text("audit_id")
      .notNull()
      .references(() => audits.id, { onDelete: "cascade" }),
    pageId: text("page_id").references(() => auditPages.id, {
      onDelete: "cascade",
    }),
    pageUrl: text("page_url").notNull(),
    issueType: text("issue_type").notNull(),
    severity: text("severity", { enum: ["critical", "warning", "info"] })
      .notNull()
      .default("info"),
    // JSON details specific to the issue type (e.g. broken link target)
    detailsJson: text("details_json"),
  },
  (table) => [
    index("audit_issues_audit_type_idx").on(table.auditId, table.issueType),
    index("audit_issues_page_id_idx").on(table.pageId),
  ],
);

// One row per audit: the prioritised readiness report (CL-300/CL-302).
//
// **One row, not one per fix.** The report is a single ordered list whose whole
// claim is its *ordering* — a blocked crawler outranks everything because it is a
// precondition — so storing fixes as rows would lose the one thing that matters and
// make the order a reconstruction. `fixes_json` keeps the array as written.
//
// **No score column, and that is enforced rather than merely intended.** CL-302's
// own test fails on any key matching `/^(score|grade|rating|points)$/`, because a
// site with a blocked crawler and perfect content averages to a healthy-looking
// middle with the one thing that matters still switched off. `why_no_score` is
// required instead: the reason there is no headline number is the report's most
// useful sentence.
export const auditReadiness = sqliteTable(
  "audit_readiness",
  {
    id: text("id").primaryKey(),
    /**
     * **Unique, so "one report per audit" is enforced rather than derived.**
     *
     * The row id is a hash of the audit id, which already implies uniqueness — but
     * that invariant lives in a derivation function three files from here, and a
     * plain index would let a second row exist the moment anyone changed that
     * derivation or wrote the row by hand. A database constraint is a guarantee;
     * a derivation function is a habit.
     */
    auditId: text("audit_id")
      .notNull()
      .unique()
      .references(() => audits.id, { onDelete: "cascade" }),
    /** One sentence describing the run. Not a verdict. */
    summary: text("summary").notNull(),
    /** Why there is no overall number, in words. Never empty. */
    whyNoScore: text("why_no_score").notNull(),
    /** The prioritised fixes, in order. `[]` is a real answer — nothing to fix. */
    fixesJson: text("fixes_json"),
    /**
     * What the run could **not** check.
     *
     * Stored beside the fixes rather than folded into them, because "we did not
     * look" and "we looked and found nothing" need opposite advice — and an empty
     * fix list with full coverage is the one output a customer reads as good news.
     */
    coverageJson: text("coverage_json"),
    /** Per-page inputs the rubric could not evaluate, with reasons. */
    unavailableJson: text("unavailable_json"),
    /** How many fixes the report carries. Denormalised for a list query. */
    fixCount: integer("fix_count").notNull().default(0),
    /** How many pages contributed a score. Denormalised the same way. */
    pageCount: integer("page_count").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  // The unique constraint above already indexes `audit_id`; a second index here
  // would be a duplicate the query planner has to choose between.
  () => [],
);

// One row per Lighthouse test (mobile + desktop per page).
export const auditLighthouseResults = sqliteTable(
  "audit_lighthouse_results",
  {
    id: text("id").primaryKey(),
    auditId: text("audit_id")
      .notNull()
      .references(() => audits.id, { onDelete: "cascade" }),
    pageId: text("page_id")
      .notNull()
      .references(() => auditPages.id, { onDelete: "cascade" }),
    strategy: text("strategy", { enum: ["mobile", "desktop"] }).notNull(),
    performanceScore: integer("performance_score"),
    accessibilityScore: integer("accessibility_score"),
    bestPracticesScore: integer("best_practices_score"),
    seoScore: integer("seo_score"),
    lcpMs: real("lcp_ms"),
    cls: real("cls"),
    inpMs: real("inp_ms"),
    ttfbMs: real("ttfb_ms"),
    errorMessage: text("error_message"),
    r2Key: text("r2_key"),
    payloadSizeBytes: integer("payload_size_bytes"),
  },
  (table) => [
    index("audit_lighthouse_results_audit_id_idx").on(table.auditId),
    index("audit_lighthouse_results_page_id_idx").on(table.pageId),
  ],
);
