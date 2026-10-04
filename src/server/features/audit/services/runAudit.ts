import { auditAiCrawlers } from "@/server/features/audit/services/aiCrawlerAudit";
import { auditLlmsTxt } from "@/server/features/audit/services/llmsTxtAudit";
import { scoreCitability } from "@/server/features/audit/services/citabilityScore";
import { buildReadinessReport } from "@/server/features/audit/services/readinessReport";

/**
 * The audit's orchestrator: four checks that could each stand alone, run
 * together and reconciled into one prioritised list.
 *
 * ## Why this exists as a separate module
 *
 * `auditAiCrawlers`, `auditLlmsTxt`, `scoreCitability` and `buildReadinessReport`
 * are four pure functions with **no caller between them** — each was reachable
 * only from its own test. That is the same shape as `ai_keyword_volume`,
 * `forecast_traffic` and `serp_ask`: the capability existed and nothing exposed
 * it. The predicting question is *who can reach this*, not *does it exist*.
 *
 * ## The three rules this orchestrator exists to enforce
 *
 * **1. A third state is not a pass.** GPTBot `unspecified` maps to `null`, never
 * to `true`. `robots-parser` resolves a missing rule to "allowed" (the HTTP
 * convention, almost certainly not the owner's intent), so a boolean read here
 * reports a site that believes it opted in when it opted out — a false all-clear
 * on the single check where a false all-clear is most expensive.
 *
 * **2. A failed fetch is not an empty result.** Every input that could not be
 * obtained is `null`/absent, and the checks model that themselves. `null` reads
 * as *not measured*, and the score leaves it out of the denominator entirely.
 * Zero-filling would make a page we could not measure look bad — the commonest
 * way a composite score becomes a lie.
 *
 * **3. Null propagates through an aggregate, it does not sum away.** If one of
 * several pages could not be scored, the run's `coverage` is reduced rather than
 * averaged away, because a run knows its total only if *every* page knew its own.
 * `null + null === 0` in JavaScript, so a naive `+=` fabricates a denominator.
 *
 * ## Why it is pure, and what that costs
 *
 * All four inputs are plain data and no I/O happens here — the fetches happen
 * upstream and their failures are visible in `unavailable`. That is deliberate:
 * **a rule that cannot be tested without a network is a rule that will not be
 * tested**, and this is the file that decides what a customer is told.
 */
export type AuditPageInput = {
  /** The page being audited, as the caller will show it to the user. */
  url: string;
  /**
   * Heading structure, as the content parser returned it. `null` when the parse
   * did not run or failed — which is *not* the same as a page with no headings,
   * and the distinction changes the score.
   */
  headings: Array<{ title: string; level: number | null }> | null;
  /** Schema.org types for the page. `null` when no parser ran. */
  schemaTypes: string[] | null;
  /**
   * Archived-answer measurements for this URL. `null` for the whole triple when
   * no archived answer mentions it — *no measurement*, not a measurement of zero.
   */
  citationsObserved: number | null;
  answersObserved: number | null;
  competingPagesCited: number | null;
};

export type AuditRunInput = {
  /** The site origin, for the llms.txt check to spell out resolved URLs. */
  origin: string;
  /** robots.txt as fetched, or `null` if it could not be read. */
  robotsText: string | null;
  /** `/llms.txt` as fetched, or `null` if it was not there. */
  llmsTxtBody: string | null;
  /**
   * Why robots.txt or llms.txt could not be obtained, when that is the reason.
   * Reported in `coverage` so an empty fix list never reads as "you are ready".
   */
  unavailable: string[];
  pages: AuditPageInput[];
};

/**
 * One finding about the site as a whole rather than about a single page.
 *
 * Module-private: the inferred return type carries these, and knip enforces that
 * an export nobody names is a lie about the API surface.
 */
type RunDiagnostic = {
  id: string;
  what: string;
};

type AuditRunResult = {
  /** The prioritised fix list — the deliverable. */
  fixes: ReturnType<typeof buildReadinessReport>["fixes"];
  /** What the run could not check. Empty coverage is not a clean bill of health. */
  coverage: string[];
  /** Always populated. Why there is no headline number, in words. */
  whyNoScore: string;
  /** One sentence describing the run. */
  summary: string;
  /**
   * Per-page citability, one entry per page that was scored.
   *
   * **A page that could not be scored is absent rather than null-scored**, because
   * a `null` in the list invites a reader to treat it as a zero, and it is not
   * one — the same reason `citabilityScore` leaves an unevaluated factor out of
   * the denominator instead of zero-filling it.
   */
  pages: Array<{ url: string; score: number | null; coverage: number }>;
  /**
   * Everything the run could not evaluate, in its own words.
   *
   * **A separate list from `coverage` on purpose.** `coverage` is the report's
   * own account of itself; this is the run's, including reasons that never
   * reached a check because the input was never obtained.
   */
  unavailable: RunDiagnostic[];
};

export function runAudit(input: AuditRunInput): AuditRunResult {
  const crawlers = auditAiCrawlers(input.robotsText);
  const llmsTxt = auditLlmsTxt(input.llmsTxtBody, input.origin);

  // **Rule 1: the third state.** `unspecified` is silence, and silence is a
  // decision the owner has to make on purpose — so it is *not measured*, not a
  // pass. A finding we could not locate at all is also `null`, for the same
  // reason: an absent entry is an absence of evidence, not evidence of absence.
  const gptBot = crawlers.findings.find(
    (finding) => finding.crawler === "GPTBot",
  );
  const aiCrawlerAllowed =
    gptBot === undefined || gptBot.status === "unspecified"
      ? null
      : gptBot.status === "allowed";

  const scored = input.pages.map((page) => {
    const citability = scoreCitability({
      // Structure, derived from what the parser actually returned. `null` in,
      // `null` out — a page we could not parse is not a page with no structure.
      entityDefinition: entityDefinition(page),
      answerFirst: answerFirst(page),
      questionHeaderRatio: questionHeaderRatio(page),
      schemaTypes: page.schemaTypes,
      aiCrawlerAllowed,
      citationsObserved: page.citationsObserved,
      answersObserved: page.answersObserved,
      competingPagesCited: page.competingPagesCited,
    });
    return { url: page.url, citability };
  });

  // **Rule 3: null propagates, it does not sum away.** A page with no archived
  // answers leaves the run's coverage below 1, which is the honest total — a run
  // knows its coverage only if every page knew its own.
  const scoredCoverage =
    scored.length === 0
      ? 0
      : scored.reduce((sum, page) => sum + page.citability.coverage, 0) /
        scored.length;

  // The report takes **one** page's citability as its quality signal. The page
  // with the most coverage wins, because a page measured on 4 factors is a
  // better-grounded recommendation than one measured on 1 — and `null` coverage
  // is not a candidate at all.
  const best = scored.reduce<(typeof scored)[number] | null>(
    (winner, candidate) => {
      if (candidate.citability.coverage === 0) return winner;
      if (winner === null) return candidate;
      return candidate.citability.coverage > winner.citability.coverage
        ? candidate
        : winner;
    },
    null,
  );

  const report = buildReadinessReport({
    crawlers,
    llmsTxt,
    citability: best === null ? null : best.citability,
  });

  const pages: AuditRunResult["pages"] = [];
  for (const entry of scored) {
    if (entry.citability.coverage === 0) continue;
    pages.push({
      url: entry.url,
      score: entry.citability.score,
      coverage: entry.citability.coverage,
    });
  }

  const unavailable: RunDiagnostic[] = [];
  for (const reason of input.unavailable) {
    unavailable.push({ id: reason, what: reason });
  }

  const coverage = [...report.coverage];
  // The run's own coverage is the *mean over pages*, and saying so is the point:
  // a reader who sees "the site looks ready" must be able to tell that one page
  // of ten was measurable and the other nine were not.
  if (scored.length > 0 && scoredCoverage < 1) {
    coverage.push(
      `${Math.round(scoredCoverage * 100)}% of page-level evidence was collected across ${scored.length} page(s)`,
    );
  }
  if (input.pages.length === 0) {
    coverage.push(
      "no pages were supplied, so nothing about page content was checked",
    );
  }

  return {
    fixes: report.fixes,
    coverage,
    whyNoScore: report.whyNoScore,
    summary: report.summary,
    pages,
    unavailable,
  };
}

/**
 * Does the page name its subject unambiguously?
 *
 * **A null when there are no headings, not a zero.** A page the parser could not
 * read is not a page with no structure, and a page whose one heading is a real
 * title is not a page that has not defined its subject — so a single `h1` scores
 * full marks rather than failing a ratio that one heading makes either 0% or 100%.
 */
function entityDefinition(page: AuditPageInput): number | null {
  const headings = page.headings;
  if (headings === null) return null;
  const h1 = headings.filter((heading) => heading.level === 1);
  if (h1.length === 0) return null;
  if (h1.length > 1) return 0;
  return 1;
}

/**
 * Does the page lead with the answer?
 *
 * **A heuristic, and stated as one.** We cannot tell what an AI reader considers
 * "the answer" — only a measured factor (CL-301's `competitive_density`) comes
 * from the archive. So this reads the first heading's length as a proxy for a
 * declarative opener, and returns `null` when there is nothing to read.
 */
function answerFirst(page: AuditPageInput): number | null {
  const headings = page.headings;
  if (headings === null) return null;
  const first = headings[0];
  if (first === undefined) return null;
  const title = first.title.trim();
  if (title.length === 0) return null;
  // A question is not an answer. A title under 60 characters is short enough to be
  // a declarative statement rather than a topic label.
  if (title.includes("?")) return 0;
  return title.length <= 60 ? 1 : 0;
}

/** Fraction of `h2`/`h3` headings phrased as questions, or `null` if there are none. */
function questionHeaderRatio(page: AuditPageInput): number | null {
  const headings = page.headings;
  if (headings === null) return null;
  const subheads = headings.filter(
    (heading) => heading.level === 2 || heading.level === 3,
  );
  if (subheads.length === 0) return null;
  const questions = subheads.filter((heading) =>
    heading.title.includes("?"),
  ).length;
  return questions / subheads.length;
}
