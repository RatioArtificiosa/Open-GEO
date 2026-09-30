/**
 * The slice of CL-301's result this report needs.
 *
 * Declared structurally rather than imported, because `citabilityScore.ts` keeps
 * its own types private (knip enforces it) and widening that module's API for a
 * second consumer would be exporting a shape nothing there needs to be named by.
 * Three fields, and the coupling is visible on both sides.
 */
type CitabilitySlice = {
  coverage: number;
  heuristicShare: number | null;
  topFix: { id: string; fix: string | null } | null;
};

/**
 * The AI Readiness report: every check, ordered by what a reader should do first.
 *
 * ## The ordering is the feature
 *
 * The three inputs are wildly different in cost and consequence:
 *
 * | Check | Cost to fix | Consequence if ignored |
 * |---|---|---|
 * | Blocked crawler | ~5 minutes | **The site cannot be read at all** |
 * | No `llms.txt` | ~an hour | Agents guess from your homepage |
 * | Low citability | Weeks | The page is read and skipped |
 *
 * Sorting by "how bad is the number" would put a citability score of 20 above a
 * blocked crawler, and that ordering is *wrong in a way that wastes the
 * customer's month*. Fixing a blocked crawler makes every other fix possible;
 * fixing a low citability score on a site nobody can crawl achieves nothing.
 *
 * So a **blocked crawler outranks everything, unconditionally** — not because its
 * weight is highest, but because it is a *precondition*. The checks after it are
 * ranked by weight, which is the ordinary part.
 *
 * ## No overall score, again
 *
 * A single readiness number would be actively dangerous here, and the reasoning is
 * the same as `llmsTxtAudit.ts` with more force: a site with a blocked crawler and
 * a perfect content score averages to "about 50", which reads as "half ready" —
 * and the one thing that would make the site citable is still switched off. The
 * number would be a way of hiding the only finding that mattered.
 *
 * So the report leads with the fixes and states *why* there is no score.
 */

/** A switch, an option, or a quality improvement. */
export type FixKind =
  /** The site cannot be read. Nothing else matters until this is done. */
  | "switch"
  /** A convention the site has not opted into. Cheap, and nothing works without it. */
  | "convention"
  /** A quality judgement on the content itself. Slow, and worth it last. */
  | "quality";

export type PrioritisedFix = {
  id: string;
  kind: FixKind;
  /** What to change, in one sentence. Never a score. */
  fix: string;
  /**
   * Why it sits here. Not the weight — the *consequence* of doing it or not.
   * This is the line that stops a reader re-sorting the list by their own
   * instincts, which is exactly how the crawler fix gets skipped.
   */
  because: string;
  /** A copy-pasteable artefact where one exists. */
  example: string | null;
  /** 0 is first. Stable, so the report does not reshuffle between runs. */
  order: number;
};

type ReadinessReport = {
  fixes: PrioritisedFix[];
  /**
   * What the checks actually covered, so a reader knows what the list does *not*
   * say. Empty coverage is not a clean bill of health.
   */
  coverage: string[];
  /**
   * Always populated. The reason there is no headline number, in words.
   */
  whyNoScore: string;
  summary: string;
};

const WHY_NO_SCORE =
  "There is deliberately no readiness score. A site with a blocked crawler and perfect content would average to a healthy-looking middle, and the one thing that would make it citable is still switched off. A number here would hide the finding that matters.";

export function buildReadinessReport(input: {
  /** Result of the AI-crawler check (CL-302a). */
  crawlers: {
    robotsRead: boolean;
    blocked: string[];
    unspecified: string[];
    summary: string;
  };
  /** Result of the llms.txt check (CL-300a). */
  llmsTxt: {
    fetched: boolean;
    valid: boolean;
    issues: Array<{
      code: string;
      problem: string;
      fix: string | null;
      example: string | null;
    }>;
  };
  /** Per-page citability (CL-301). Null when the crawl found no pages. */
  citability: CitabilitySlice | null;
}): ReadinessReport {
  const fixes: PrioritisedFix[] = [];

  // 1. Switches first, and unconditionally. This is a precondition: every other
  //    fix is wasted while it is open.
  if (!input.crawlers.robotsRead) {
    fixes.push({
      id: "robots-unreadable",
      kind: "switch",
      fix: "Fix robots.txt so it can be fetched, then re-run the audit.",
      because:
        "We could not read robots.txt, so we do not know what any AI crawler is allowed to do. Every other finding below is conditional on this one.",
      example: null,
      order: 0,
    });
  } else if (input.crawlers.blocked.length > 0) {
    const first = input.crawlers.blocked[0] ?? "";
    fixes.push({
      id: "crawler-blocked",
      kind: "switch",
      fix: `Unblock ${input.crawlers.blocked.join(", ")} in robots.txt.`,
      because:
        "This is a switch, not a ranking factor. While it is off, no amount of rewriting makes your content quotable — the model never reads it. Every other fix here is wasted until this is done, which is why it outranks them however good your content already is.",
      example: `User-agent: ${first}\nAllow: /`,
      order: 0,
    });
  }

  if (input.crawlers.robotsRead && input.crawlers.unspecified.length > 0) {
    fixes.push({
      id: "crawler-unspecified",
      kind: "convention",
      fix: `State explicitly whether ${input.crawlers.unspecified.slice(0, 4).join(", ")} may read this site.`,
      because:
        "Silence is a decision made by a default rather than by you, and it is not the same as consent. It is a one-line change and it is not urgent, so it sits below the switch and above the content work.",
      example: "User-agent: GPTBot\nAllow: /",
      order: 1,
    });
  }

  // 2. Conventions. Cheap, and the next thing that is actually load-bearing.
  for (const [index, issue] of input.llmsTxt.issues.entries()) {
    fixes.push({
      id: `llms-${issue.code}`,
      kind: "convention",
      fix: issue.fix ?? `Fix: ${issue.problem}`,
      because: issue.problem,
      example: issue.example,
      order: 2 + index,
    });
  }

  // 3. Quality, last. A page the model can read but will not quote.
  if (input.citability !== null && input.citability.topFix !== null) {
    fixes.push({
      id: `citability-${input.citability.topFix.id}`,
      kind: "quality",
      fix: input.citability.topFix.fix ?? "Improve this page's citability.",
      because:
        "Your site is readable by AI engines, so this is now a content problem rather than a configuration one. It is last because it is the slowest to fix and the only one where effort is genuinely required.",
      example: null,
      order: 100 + fixes.length,
    });
  }

  const report: ReadinessReport = {
    fixes,
    coverage: describeCoverage(input),
    whyNoScore: WHY_NO_SCORE,
    summary: "",
  };
  report.summary = describe(report);
  return report;
}

function describeCoverage(input: {
  crawlers: { robotsRead: boolean };
  llmsTxt: { fetched: boolean };
  citability: CitabilitySlice | null;
}): string[] {
  const out: string[] = [];
  out.push(
    input.crawlers.robotsRead
      ? "robots.txt was read, so crawler access was judged."
      : "robots.txt could NOT be read, so crawler access is unjudged.",
  );
  out.push(
    input.llmsTxt.fetched
      ? "llms.txt was fetched, so it was judged."
      : "llms.txt was NOT fetched, so its content is unjudged.",
  );
  out.push(
    input.citability === null
      ? "No pages were analysed, so citability is unjudged."
      : `Citability judged from ${Math.round(input.citability.coverage * 100)}% of the rubric; ${input.citability.heuristicShare === 1 ? "all of it heuristic" : "some of it observed"}.`,
  );
  return out;
}

function describe(report: ReadinessReport): string {
  if (report.fixes.length === 0) {
    return "No fixes outstanding. Note what that does not mean: it means the checks we ran found nothing, not that AI engines cite this site.";
  }
  const switches = report.fixes.filter((f) => f.kind === "switch").length;
  const lead =
    switches > 0
      ? `Start with the switch${switches === 1 ? "" : "es"} — nothing else you do matters until that is open. `
      : "";
  return `${lead}${report.fixes.length} fix${report.fixes.length === 1 ? "" : "es"}, ordered by consequence rather than by score.`;
}
