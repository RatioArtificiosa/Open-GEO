import { describe, expect, it } from "vitest";
import { buildReadinessReport, type PrioritisedFix } from "./readinessReport";

/**
 * The AI Readiness report.
 *
 * One property carries the whole file: **a blocked crawler outranks every other
 * fix, unconditionally.** The inputs differ in cost by three orders of magnitude
 * — five minutes for a robots.txt line against weeks for a content rewrite — and
 * the quality fixes are worthless while the switch is off, because the model never
 * reads the page.
 *
 * The tests are therefore mostly about *order*, and about what the report refuses
 * to do (average, score, imply coverage it does not have).
 */

const cleanCrawlers = {
  robotsRead: true,
  blocked: [] as string[],
  unspecified: [] as string[],
  summary: "ok",
};

const blockedCrawlers = {
  robotsRead: true,
  blocked: ["GPTBot"],
  unspecified: [] as string[],
  summary: "blocked",
};

const cleanLlms = {
  fetched: true,
  valid: true,
  issues: [] as Array<{
    code: string;
    problem: string;
    fix: string | null;
    example: string | null;
  }>,
};

const missingLlms = {
  fetched: false,
  valid: false,
  issues: [
    {
      code: "missing",
      problem: "No llms.txt was found at /llms.txt.",
      fix: "Publish one and link it from your homepage.",
      example: "# Your Company",
    },
  ],
};

const goodCitability = {
  coverage: 1,
  heuristicShare: 0.5,
  topFix: { id: "answer_first", fix: "Lead with the answer." },
};

const build = (
  over: {
    crawlers?: typeof cleanCrawlers;
    llmsTxt?: typeof cleanLlms;
    /** `topFix` may be null — a page with nothing outstanding contributes no
     * quality fix, which is a real state and not a missing one. `Omit` rather
     * than an intersection, because intersecting would keep the narrower
     * `fix: string` from `goodCitability` and make the widening pointless. */
    citability?:
      | (Omit<typeof goodCitability, "topFix"> & {
          topFix: { id: string; fix: string | null } | null;
        })
      | null;
  } = {},
) =>
  buildReadinessReport({
    crawlers: over.crawlers ?? cleanCrawlers,
    llmsTxt: over.llmsTxt ?? cleanLlms,
    citability:
      over.citability === undefined ? goodCitability : over.citability,
  });

const kinds = (fixes: PrioritisedFix[]) => fixes.map((f) => f.kind);
const ids = (fixes: PrioritisedFix[]) => fixes.map((f) => f.id);

describe("buildReadinessReport", () => {
  it("puts a blocked crawler first, ahead of a content fix", () => {
    // The claim the whole module exists for. A citability score of 20 on a site
    // nothing can read is a finding worth nothing, and listing it first would
    // send the customer to spend a month on it.
    const report = build({ crawlers: blockedCrawlers, llmsTxt: missingLlms });
    // `crawler-unspecified` is absent here because `blockedCrawlers` names no
    // unspecified agents — it is covered separately below.
    expect(ids(report.fixes)).toEqual([
      "crawler-blocked",
      "llms-missing",
      "citability-answer_first",
    ]);
    expect(kinds(report.fixes)).toEqual(["switch", "convention", "quality"]);
  });

  it("explains why the switch comes first, in the fix itself", () => {
    // A list ordered by consequence is only useful if each row says what happens
    // if you skip it — otherwise the reader re-sorts by instinct, which is
    // exactly how a robots.txt fix gets deprioritised.
    const report = build({ crawlers: blockedCrawlers });
    const first = report.fixes[0];
    expect(first?.kind).toBe("switch");
    expect(first?.because).toMatch(/never reads it/i);
    expect(first?.example).toContain("User-agent: GPTBot");
  });

  it("treats an unreadable robots.txt as the first fix, not as a pass", () => {
    const report = build({
      crawlers: { ...cleanCrawlers, robotsRead: false },
    });
    expect(ids(report.fixes)[0]).toBe("robots-unreadable");
    expect(report.coverage.join(" ")).toMatch(/robots\.txt could NOT be read/i);
  });

  it("orders switch → convention → quality, and never the other way round", () => {
    const report = build({
      crawlers: { ...cleanCrawlers, unspecified: ["ClaudeBot"] },
      llmsTxt: missingLlms,
    });
    const order = kinds(report.fixes);
    const firstSwitch = order.indexOf("switch");
    const firstQuality = order.indexOf("quality");
    const lastConvention = order.lastIndexOf("convention");
    if (firstSwitch !== -1 && firstQuality !== -1) {
      expect(firstSwitch).toBeLessThan(firstQuality);
    }
    if (lastConvention !== -1 && firstQuality !== -1) {
      expect(lastConvention).toBeLessThan(firstQuality);
    }
  });

  it("offers no headline score, and says why in words", () => {
    // A site with a blocked crawler and perfect content would average to a
    // healthy-looking middle, with the one thing that matters still switched off.
    const report = build({ crawlers: blockedCrawlers });
    for (const key of Object.keys(report)) {
      expect(key.toLowerCase()).not.toMatch(/^(score|grade|rating|points)$/);
    }
    expect(report.whyNoScore).toMatch(/no readiness score/i);
    expect(report.whyNoScore).toMatch(/still switched off/i);
  });

  it("states what it did NOT check, so an empty list is not a clean bill", () => {
    const report = build({ citability: null });
    expect(report.coverage.join(" ")).toMatch(/no pages were analysed/i);
    expect(report.summary).toMatch(/does not mean/i);
  });

  it("says 'nothing found' rather than 'ready' when there is nothing to fix", () => {
    // The distinction a customer acts on: we found no problems, or we are ready.
    // A page with no outstanding top fix is required here — a good-but-not-perfect
    // page still contributes a quality fix, which is the point of the ordering.
    const report = build({
      crawlers: cleanCrawlers,
      llmsTxt: cleanLlms,
      citability: { coverage: 1, heuristicShare: 0.5, topFix: null },
    });
    expect(report.fixes).toEqual([]);
    expect(report.summary).toMatch(/no fixes outstanding/i);
    expect(report.summary).toMatch(/not that AI engines cite this site/i);
  });

  it("leads its summary with the switch when one is open", () => {
    const report = build({ crawlers: blockedCrawlers, llmsTxt: missingLlms });
    expect(report.summary).toMatch(/start with the switch/i);
  });

  it("gives every fix a stable order, so a report does not reshuffle", () => {
    const a = build({ crawlers: blockedCrawlers, llmsTxt: missingLlms });
    const b = build({ crawlers: blockedCrawlers, llmsTxt: missingLlms });
    expect(ids(a.fixes)).toEqual(ids(b.fixes));
    const orders = a.fixes.map((f) => f.order);
    // Monotonic by comparison rather than by sorting: `no-array-sort` rejects both
    // `.sort()` and the `[...x].sort()` spread, and `toSorted` is not in this
    // repo's `lib` target. The test is about the *order*, so checking it pairwise
    // says what it means.
    for (let i = 1; i < orders.length; i += 1) {
      const previous = orders[i - 1];
      const current = orders[i];
      expect(previous, `order went backwards at index ${i}`).toBeLessThan(
        current ?? Number.POSITIVE_INFINITY,
      );
    }
  });

  it("carries the llms.txt issue text through rather than restating it", () => {
    const report = build({ llmsTxt: missingLlms });
    const fix = report.fixes.find((f) => f.id === "llms-missing");
    expect(fix?.fix).toBe("Publish one and link it from your homepage.");
    expect(fix?.example).toBe("# Your Company");
  });
});
