import type { WorkflowStepConfig } from "cloudflare:workers";

/**
 * Explicit step configs for the site-audit workflow.
 *
 * Without these, steps inherit the platform default (10-minute timeout,
 * multiple retries with backoff) — production audits against slow/hostile
 * sites burned ~65 minutes replaying a doomed step before erroring. Every
 * step now has a timeout sized to its real work and a small retry budget.
 */

/** Robots + sitemap walk (bounded at 300 docs / 15s per fetch internally). */
export const DISCOVERY_STEP: WorkflowStepConfig = {
  retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
  timeout: "4 minutes",
};

/** One crawl chunk: ~90s soft crawl deadline + persistence headroom. */
export const CRAWL_CHUNK_STEP: WorkflowStepConfig = {
  retries: { limit: 1, delay: "10 seconds", backoff: "constant" },
  timeout: "5 minutes",
};

/**
 * One Lighthouse URL (mobile + desktop). DataForSEO charges these calls, so a
 * Workflow replay must never issue them again after the step starts.
 */
export const LIGHTHOUSE_FETCH_STEP: WorkflowStepConfig = {
  retries: { limit: 0, delay: "1 second" },
  timeout: "5 minutes",
};

/** R2 + DB persistence is idempotent and safe to retry after the paid step. */
export const LIGHTHOUSE_PERSIST_STEP: WorkflowStepConfig = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};

/** Small DB-only steps (validate, select sample, finalize, mark-failed). */
export const DB_STEP: WorkflowStepConfig = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
};

/** Cross-page checks read every page row of the audit — allow more time. */
export const MULTIPAGE_CHECKS_STEP: WorkflowStepConfig = {
  retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};

/**
 * The citability report: reads every page row and fetches two small files from
 * the customer's origin.
 *
 * **Sized for the reads, not the network.** The page query is the expensive part
 * on a large audit, and both fetches carry their own 10s timeouts, so the floor is
 * the query plus up to 10s. Two minutes is generous; a site that needs more is a
 * site whose robots.txt or llms.txt is hanging, and `runReadiness` already turns
 * that into a gap rather than a failure.
 *
 * **Retries are cheap because nothing here is billed.** No DataForSEO call is in
 * this step, so replaying it costs a little compute and buys a real retry — the
 * opposite of `LIGHTHOUSE_FETCH_STEP`, which must never replay.
 */
export const READINESS_STEP: WorkflowStepConfig = {
  retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
};
