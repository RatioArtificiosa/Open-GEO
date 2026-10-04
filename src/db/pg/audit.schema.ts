import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  text,
} from "drizzle-orm/pg-core";
import { PAGE_FETCH_CLASSES } from "@/shared/audit-fetch-class";
import { projects } from "./app.schema";

// Timestamps are stored as *text* (same column shape as the SQLite schema); see
// the note in pg/app.schema.ts. `isoNow` matches `new Date().toISOString()` so
// DB-defaulted and app-written values sort together lexicographically.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const timestampColumn = (name: string) => text(name);

// ============================================================================
// Site Audit tables
// ============================================================================

// One row per audit run
export const audits = pgTable(
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
    startedAt: timestampColumn("started_at").notNull().default(isoNow),
    completedAt: timestampColumn("completed_at"),
  },
  (table) => [
    index("audits_project_id_idx").on(table.projectId),
    index("audits_started_by_user_id_idx").on(table.startedByUserId),
  ],
);

// One row per crawled page
export const auditPages = pgTable(
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
    hasStructuredData: boolean("has_structured_data").notNull().default(false),
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
    isIndexable: boolean("is_indexable").notNull().default(true),
    // Indexability/canonical signals from response headers
    xRobotsTag: text("x_robots_tag"),
    headerCanonicalUrl: text("header_canonical_url"),
    // Crawl metadata
    // null depth = not reached via links (e.g. sitemap-seeded)
    crawlDepth: integer("crawl_depth"),
    inSitemap: boolean("in_sitemap").notNull().default(false),
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
export const auditIssues = pgTable(
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
// make the order a reconstruction.
//
// **No score column.** CL-302's own test fails on any key matching
// `/^(score|grade|rating|points)$/`, because a site with a blocked crawler and
// perfect content averages to a healthy-looking middle with the one thing that
// matters still switched off. `why_no_score` is required instead.
export const auditReadiness = pgTable(
  "audit_readiness",
  {
    id: text("id").primaryKey(),
    auditId: text("audit_id")
      .notNull()
      .references(() => audits.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    whyNoScore: text("why_no_score").notNull(),
    /** The prioritised fixes, in order. `[]` is a real answer. */
    fixesJson: text("fixes_json"),
    /** What the run could not check — "did not look" and "found nothing" differ. */
    coverageJson: text("coverage_json"),
    unavailableJson: text("unavailable_json"),
    fixCount: integer("fix_count").notNull().default(0),
    pageCount: integer("page_count").notNull().default(0),
    // **ISO text, not a `timestamp` column** — the same choice every other audit
    // table makes, and the reason is in `pg/app.schema.ts`: DB-defaulted and
    // app-written values have to sort together, and `isoNow` emits exactly what
    // `new Date().toISOString()` does. A native `timestamptz` would parse and
    // reorder the two, and the parity test compares `dataType`, so it caught this
    // on the first run. **The gate working is the point of the gate.**
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [index("audit_readiness_audit_id_idx").on(table.auditId)],
);

// One row per Lighthouse test (mobile + desktop per page).
export const auditLighthouseResults = pgTable(
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
