/**
 * Shared types for the site audit system.
 */

import { z } from "zod";
import type { PageFetchClass } from "@/shared/audit-fetch-class";
import { MIN_AUDIT_PAGES, PAID_MAX_AUDIT_PAGES } from "@/shared/audit-limits";
import { jsonCodec } from "@/shared/json";
import type { StuffedTerm } from "@/server/lib/audit/keyword-density";

export type LighthouseStrategy = "auto" | "none";

export interface AuditConfig {
  maxPages: number;
  lighthouseStrategy: LighthouseStrategy;
}

// Read-side only (writes stringify a typed AuditConfig). Stored rows may hold
// retired strategies ("all", "manual") from older audits; map them onto the
// closest surviving strategy — and fall back to "auto" on anything unknown —
// instead of failing the whole config parse and making the audit's results
// unviewable.
const lighthouseStrategySchema = z
  .enum(["auto", "all", "manual", "none"])
  .transform(
    (value): LighthouseStrategy =>
      value === "all" ? "auto" : value === "manual" ? "none" : value,
  )
  .catch("auto");

const auditConfigSchema = z.object({
  maxPages: z.number().int().min(MIN_AUDIT_PAGES).max(PAID_MAX_AUDIT_PAGES),
  lighthouseStrategy: lighthouseStrategySchema,
});

const auditConfigCodec = jsonCodec(auditConfigSchema);

export function parseAuditConfig(configRaw: string | null): AuditConfig | null {
  if (!configRaw) return null;
  const result = auditConfigCodec.safeParse(configRaw);
  return result.success ? result.data : null;
}

/** One outgoing link edge, deduped by target URL within a page. */
export interface PageLink {
  targetUrl: string;
  anchor: string | null;
  isInternal: boolean;
  isNofollow: boolean;
}

/** Data extracted from a single page's HTML. */
export interface PageAnalysis {
  url: string;
  statusCode: number;
  redirectUrl: string | null;
  responseTimeMs: number;

  // Head metadata
  title: string;
  metaDescription: string;
  canonical: string | null;
  robotsMeta: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;

  // Headings
  h1s: string[];
  headingOrder: number[];
  /**
   * Heading text with its level, in document order.
   *
   * **Added because everything downstream needed it and the parser already had
   * it.** The audit's citability rubric asks whether a page leads with an answer
   * and what fraction of its subheadings are questions — both impossible to
   * answer from `headingOrder`, which is levels only. Heading text was collected
   * for h1 and then discarded by `crawlPage`; h2–h6 text was never collected at
   * all. `h1s` remains because four existing callers read it, and it is now
   * derived from this list so the two cannot disagree.
   */
  headings: Array<{ level: number; title: string }>;

  // Content
  wordCount: number;
  bodyText: string;
  /**
   * Terms the page repeats past the point of prose, strongest first.
   *
   * **Derived here and capped, rather than carrying `bodyText` onward.** A whole page's
   * text in every record would sit in the 25-page persist batches, which is the shape of
   * this engine's past memory failures; a handful of terms is the signal the report
   * needs. Transient: not persisted, consumed in the same run.
   */
  stuffedTerms: StuffedTerm[];

  // Images
  images: Array<{ src: string | null; alt: string | null }>;

  // Links (normalized, deduped by target)
  links: PageLink[];

  // Structured data
  hasStructuredData: boolean;
  /**
   * Schema.org `@type` names found in the page's JSON-LD.
   *
   * **Extracted rather than asked of the vendor.** `hasStructuredData` says a
   * block exists; this says what it declares, which is what the citability
   * rubric's schema-coverage factor actually needs. The bytes were already being
   * tokenized by the parser, so reading the types costs nothing.
   *
   * Empty means *no types were found*, which is a finding. A page with no JSON-LD
   * at all is `hasStructuredData: false` with the same empty list, and the
   * difference between the two is what the rubric cannot currently express —
   * so `null` is reserved for a caller that never ran a parse.
   */
  schemaTypes: string[];

  // Hreflang
  hreflangTags: string[];
}

/** Lighthouse result for a single URL+strategy. */
export interface LighthouseResult {
  url: string;
  pageId: string;
  strategy: "mobile" | "desktop";
  performanceScore: number | null;
  accessibilityScore: number | null;
  bestPracticesScore: number | null;
  seoScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  ttfbMs: number | null;
  errorMessage?: string | null;
  r2Key?: string | null;
  payloadSizeBytes?: number | null;
}

/**
 * Full result of crawling one page. Persisted to the app DB inside the
 * crawl-chunk step; never accumulated in memory or returned as durable
 * step state.
 */
export interface CrawledPageResult {
  id: string;
  url: string;
  statusCode: number;
  fetchClass: PageFetchClass;
  redirectUrl: string | null;
  title: string;
  metaDescription: string;
  canonicalUrl: string | null;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  headerCanonicalUrl: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  h1Count: number;
  h2Count: number;
  h3Count: number;
  h4Count: number;
  h5Count: number;
  h6Count: number;
  headingOrder: number[];
  /**
   * Heading text with its level, in document order.
   *
   * **Carried through `crawlPage` because that is where the text used to die.**
   * The analyzer collected h1 text and `crawlPage` reduced it to a count, so the
   * citability rubric had no way to ask what a heading *said* — only how many
   * there were. Transient, like `isHtml`: persisted as counts and level order,
   * and consumed in the same run by anything needing the text.
   */
  headings: Array<{ level: number; title: string }>;
  wordCount: number;
  contentHash: string | null;
  /**
   * True when an HTML document was fetched and analyzed. Gates the content
   * checks in page reporters (an empty-shell HTML page must still be
   * checked; a PDF must not). Transient — not persisted.
   */
  isHtml: boolean;
  /**
   * HTML size read for this page (approximate; capped at MAX_HTML_BYTES).
   * Transient — feeds the crawl window's memory-pressure signal, since
   * response time is measured at headers and says nothing about body size.
   */
  htmlBytes: number;
  /**
   * True when a 429 was retried for this URL (whatever the retry returned).
   * Not persisted — narrows the crawl window so the pages after it are
   * fetched more slowly.
   */
  rateLimited: boolean;
  imagesTotal: number;
  imagesMissingAlt: number;
  images: Array<{ src: string | null; alt: string | null }>;
  links: PageLink[];
  hasStructuredData: boolean;
  /**
   * Schema.org `@type` names for the page.
   *
   * Empty on `emptyPageResult`, which is a distinct state from a parsed page
   * carrying no types — the first is *not analysed*, the second is a finding.
   */
  schemaTypes: string[];
  /** Terms repeated past the point of prose. Transient; see `PageAnalysis`. */
  stuffedTerms: StuffedTerm[];
  hreflangTags: string[];
  isIndexable: boolean;
  responseTimeMs: number;
  /** null = not reached via links (e.g. sitemap-seeded). */
  crawlDepth: number | null;
  inSitemap: boolean;
}
