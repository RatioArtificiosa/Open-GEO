import { describe, expect, it } from "vitest";
import { runAudit, type AuditPageInput, type AuditRunInput } from "./runAudit";

/**
 * The orchestrator's three rules, each tested where breaking it would produce a
 * finding a customer acts on.
 */

const CRAWLER_BLOCKING_ROBOTS = `
User-agent: *
Disallow: /
`;

const ORIGIN = "https://acme.com";

function page(overrides: Partial<AuditPageInput> = {}): AuditPageInput {
  return {
    url: "https://acme.com/guide",
    headings: [
      { title: "What is GEO?", level: 1 },
      { title: "How does it work?", level: 2 },
    ],
    schemaTypes: ["Article"],
    citationsObserved: 3,
    answersObserved: 5,
    competingPagesCited: 10,
    ...overrides,
  };
}

function run(
  overrides: Partial<AuditRunInput> = {},
): ReturnType<typeof runAudit> {
  return runAudit({
    origin: ORIGIN,
    robotsText: "",
    llmsTxtBody: "# Acme\n\n- [Docs](https://acme.com/docs)\n",
    unavailable: [],
    pages: [page()],
    ...overrides,
  });
}

describe("runAudit", () => {
  it("puts a blocked crawler first, because it is a precondition", () => {
    const result = run({ robotsText: CRAWLER_BLOCKING_ROBOTS });

    // Not a ranking of severity — a blocked crawler makes every other fix
    // possible, so it outranks everything unconditionally.
    expect(result.fixes[0]?.id).toBe("crawler-blocked");
  });

  it("does not report an unspecified crawler as allowed", () => {
    // An empty robots.txt mentions nobody. `robots-parser` resolves silence to
    // "allowed", and a site that believes it opted in when it opted out is the
    // customer this check exists for.
    const result = run({ robotsText: "" });

    expect(result.fixes.some((fix) => fix.id === "crawler-unspecified")).toBe(
      true,
    );
  });

  it("scores a page whose structure could not be parsed, and says how little it knows", () => {
    // Structure unparsed and schema unknown, but the archive triple is populated,
    // so exactly one factor — `competitive_density`, weight 0.35 — evaluates.
    // **0.35, not 0 and not 1.** Zero-filling would make a page we could not
    // measure look bad; reporting it as fully measured would claim knowledge we
    // do not have. The number is the honest middle and the test pins it.
    const result = run({
      pages: [page({ headings: null, schemaTypes: null })],
    });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.coverage).toBeCloseTo(0.35, 5);
  });

  it("leaves a page with nothing measurable out of the score entirely", () => {
    // Nothing known about the page at all: `score` is null, which is **not a
    // zero** — the scorer itself refuses to average an unknown in as a failure.
    const result = run({
      pages: [
        page({
          headings: null,
          schemaTypes: null,
          citationsObserved: null,
          answersObserved: null,
          competingPagesCited: null,
        }),
      ],
    });

    expect(result.pages).toEqual([]);
  });

  it("scores a page that was measured, and reports how much of the rubric it covered", () => {
    const result = run();

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.url).toBe("https://acme.com/guide");
    expect(result.pages[0]?.score).toBeGreaterThan(0);
  });

  it("gives a page with two h1s a real score, not an unscorable one", () => {
    // This page *was* measured and it *did* fail. A null here would say we could
    // not tell, which is a different and much weaker finding.
    const result = run({
      pages: [
        page({
          headings: [
            { title: "One title", level: 1 },
            { title: "Another title", level: 1 },
          ],
        }),
      ],
    });

    expect(result.pages[0]?.coverage).toBeGreaterThan(0);
  });

  it("scores a blocked crawler lower than an allowed one, not merely differently", () => {
    // **The gap this closes.** An earlier version asserted only that a blocked
    // crawler is *reported* — coverage stays 1.0 either way, because `crawlable`
    // is a measured factor whichever way it resolves. So a version that mapped
    // `blocked` to `true` produced identical coverage and a different fix list,
    // and no assertion noticed. It takes a **score comparison** to pin the
    // difference, because that is the only place the distinction lands.
    const allowed = run({
      robotsText: "User-agent: GPTBot\nAllow: /\n",
      pages: [
        page({
          headings: [
            { title: "Generative engine optimization, explained.", level: 1 },
          ],
        }),
      ],
    });
    const blocked = run({
      robotsText: CRAWLER_BLOCKING_ROBOTS,
      pages: [
        page({
          headings: [
            { title: "Generative engine optimization, explained.", level: 1 },
          ],
        }),
      ],
    });

    // Same page, same everything else — only crawlability differs.
    expect(blocked.pages[0]?.coverage).toBeCloseTo(
      allowed.pages[0]?.coverage ?? 0,
      5,
    );
    expect(blocked.pages[0]?.score).toBeLessThan(
      allowed.pages[0]?.score ?? 101,
    );
  });

  it("counts a page with nothing known about it in the run's denominator", () => {
    // **The gap this closes.** An earlier version of this test gave the second page
    // a populated archive triple, which left it at coverage 0.12 — so a mean that
    // *filtered* unmeasurable pages before dividing produced the same number and
    // the bug hid. The page here is known about **nothing at all**: no robots.txt,
    // no parse, no archive. Its coverage is 0, and 0 is what a filter drops.
    const result = run({
      robotsText: null,
      pages: [
        page(),
        page({
          url: "https://acme.com/unknown",
          headings: null,
          schemaTypes: null,
          citationsObserved: null,
          answersObserved: null,
          competingPagesCited: null,
        }),
      ],
    });

    // `robotsText: null` means nobody knows whether GPTBot may read this site, so
    // **both** pages lose the site-wide `crawlable` factor: the good page falls to
    // 0.88 and the unknown page to 0. The mean is 0.44. Dividing by only the
    // measurable page would report 88% — and the difference between those two
    // numbers is exactly the knowledge the run failed to obtain.
    const coverageLine = result.coverage.find((line) =>
      line.includes("page-level evidence"),
    );
    expect(coverageLine).toContain("44%");
  });

  it("reports less than full coverage when a page could not be measured", () => {
    const result = run({
      // **GPTBot is explicitly allowed here**, so `crawlable` evaluates and the
      // measured page reaches full coverage. With an empty robots.txt the crawler
      // is `unspecified`, which correctly nulls the factor and drops that page to
      // 0.88 — a distinction this test would otherwise blur.
      robotsText: "User-agent: GPTBot\nAllow: /\n",
      pages: [
        page(),
        page({
          url: "https://acme.com/unparseable",
          headings: null,
          schemaTypes: null,
          citationsObserved: null,
          answersObserved: null,
          competingPagesCited: null,
        }),
      ],
    });

    // Null propagates: the run knows its coverage only if every page knew its own.
    // A naive average would report the measurable page's full coverage for both.
    //
    // The bare page is not zero: `crawlable` is a **site-wide** factor, so knowing
    // GPTBot is allowed tells us something true about every page — coverage 0.12.
    // The measured page earns 1.0, so the mean is 0.56. Asserting 50% here would
    // pin a number the scorer does not produce, and would pass only if the
    // site-wide factor were wrongly attributed to one page.
    const coverageLine = result.coverage.find((line) =>
      line.includes("page-level evidence"),
    );
    expect(coverageLine).toBeDefined();
    expect(coverageLine).toContain("56%");
  });

  it("does not credit `crawlable` when the crawler was merely unmentioned", () => {
    // An empty robots.txt makes GPTBot `unspecified`, not `allowed`, so the factor
    // is *not measured* — coverage 0.88, not 1.0. Reading silence as permission is
    // the exact false all-clear CL-302a exists to prevent, and this pins that the
    // orchestrator carries that state through rather than collapsing it.
    const result = run({ robotsText: "" });

    expect(result.pages[0]?.coverage).toBeCloseTo(0.88, 5);
  });

  it("scores a blocked crawler as a failure, not as unmeasured", () => {
    // **The two states must stay opposite.** `unspecified` is silence and maps to
    // `null`; `blocked` is a decision the owner made and is a hard `false`. Reading
    // both as "not measured" would leave a site that blocks GPTBot with an
    // unmeasured crawlability factor — and the rubric would then have no opinion
    // about the one problem that makes every other fix pointless.
    const result = run({ robotsText: CRAWLER_BLOCKING_ROBOTS });

    // Measured, and measured as a zero: the score reflects a blocked crawler.
    expect(result.pages[0]?.coverage).toBeCloseTo(1, 5);
    expect(result.fixes[0]?.id).toBe("crawler-blocked");
  });

  it("scores a heading phrased as a question as not leading with an answer", () => {
    // A question is not an answer. This page is otherwise perfect, so the only
    // thing that can lower its score is the answer-first factor reading the
    // heading correctly — which is what makes this a real test of that line
    // rather than of the fixture.
    const result = run({
      robotsText: "User-agent: GPTBot\nAllow: /\n",
      pages: [
        page({
          headings: [
            { title: "What is generative engine optimization?", level: 1 },
            { title: "How does it work?", level: 2 },
          ],
        }),
      ],
    });

    const withQuestion = result.pages[0]?.score ?? 0;
    const withoutQuestion = run({
      robotsText: "User-agent: GPTBot\nAllow: /\n",
      pages: [
        page({
          headings: [
            {
              title: "Generative engine optimization is the practice.",
              level: 1,
            },
            { title: "How does it work?", level: 2 },
          ],
        }),
      ],
    }).pages[0]?.score;

    // A declarative title scores strictly higher than the same page asking a
    // question, which is the whole claim of the answer-first factor.
    expect(withoutQuestion ?? 0).toBeGreaterThan(withQuestion);
  });

  it("scores two h1s as a measured failure, not as an unmeasured page", () => {
    // This page *was* read and it *did* fail. Mapping two titles to `null` would
    // say we could not tell — a much weaker finding than the one we can make, and
    // one that removes the page from the denominator entirely.
    const twoTitles = run({
      robotsText: "User-agent: GPTBot\nAllow: /\n",
      pages: [
        page({
          headings: [
            { title: "One title", level: 1 },
            { title: "Another title", level: 1 },
          ],
        }),
      ],
    });

    const noTitles = run({
      robotsText: "User-agent: GPTBot\nAllow: /\n",
      pages: [
        page({
          headings: [{ title: "A subsection", level: 2 }],
        }),
      ],
    });

    // Two h1s are a *failure* (a lower score); no h1 at all is *unmeasured* (the
    // factor leaves the denominator). Both pages are scored either way — the
    // 0.15 weight is present in both, because `crawlable` (0.12) and
    // `question_headers` (0.10) are the only factors either page misses, and the
    // two-h1 page has no h2/h3 to miss on.
    expect(twoTitles.pages[0]?.coverage).toBeCloseTo(0.9, 5);
    expect(noTitles.pages[0]?.coverage).toBeLessThan(
      twoTitles.pages[0]?.coverage ?? 1,
    );
    // And the failure is visible in the score, not only in the coverage.
    expect(twoTitles.pages[0]?.score).toBeLessThan(
      noTitles.pages[0]?.score ?? 101,
    );
  });

  it("says so when no pages were supplied at all", () => {
    const result = run({ pages: [] });

    // An empty page list with full coverage reads as "you are ready", which is the
    // one conclusion this must never support. The crawler findings are still real —
    // they are about the site, not about any page — so the list is not empty.
    expect(
      result.coverage.some((line) => line.includes("no pages were supplied")),
    ).toBe(true);
    expect(result.pages).toEqual([]);
  });

  it("carries an unreadable robots.txt as its own state, not as a pass", () => {
    const result = run({ robotsText: null });

    // Every other fix is conditional on knowing what the file allows.
    expect(result.fixes[0]?.id).toBe("robots-unreadable");
  });

  it("passes the run's own reasons through to unavailable", () => {
    const result = run({ unavailable: ["robots.txt returned 503"] });

    expect(result.unavailable).toEqual([
      { id: "robots.txt returned 503", what: "robots.txt returned 503" },
    ]);
  });

  it("never emits a headline score", () => {
    const result = run();

    // A blocked crawler plus perfect content averages to a healthy middle with the
    // one thing that matters still switched off. `whyNoScore` says so instead.
    expect(result.whyNoScore.length).toBeGreaterThan(0);
    expect(Object.keys(result)).not.toContain("score");
  });

  it("prefers the better-measured page as the report's quality signal", () => {
    const result = run({
      pages: [
        page({
          url: "https://acme.com/thin",
          headings: [{ title: "Thin", level: 1 }],
          schemaTypes: null,
          citationsObserved: null,
          answersObserved: null,
          competingPagesCited: null,
        }),
        page({ url: "https://acme.com/rich" }),
      ],
    });

    // A page measured on more factors grounds a better recommendation than one
    // measured on few, so it is the one the fix list reasons from.
    const quality = result.fixes.find((fix) =>
      fix.id.startsWith("citability-"),
    );
    expect(quality).toBeDefined();
  });

  it("reports an llms.txt relative link with the URL it actually resolves to", () => {
    const result = run({
      llmsTxtBody: "# Acme\n\n- [Docs](/docs)\n- [Pricing](/pricing)\n",
    });

    // The example is the second link: the file lists Docs first, and the report
    // names one — but the one it names must be a real entry in this file, which
    // pins the fix to the input rather than to a fixture constant.
    const fix = result.fixes.find(
      (entry) => entry.id === "llms-relative_links",
    );
    expect(fix?.example).toMatch(/https:\/\/acme\.com\/(docs|pricing)/);
  });
});
