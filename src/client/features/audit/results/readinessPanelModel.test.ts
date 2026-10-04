import { describe, expect, it } from "vitest";
import {
  coverageNote,
  fixBorderRule,
  readinessHeadline,
} from "./readinessPanelModel";

/**
 * The readiness panel's decisions.
 *
 * Everything testable in the panel is a decision about **what to say**, and the
 * project convention is to extract that rather than render it — `ScoreRing` does
 * the same with `arcFor`, and `LivePanels` with its panel logic. The suite is
 * `*.test.ts` for the same reason: a `.tsx` test would need a DOM to assert two
 * strings.
 *
 * The load-bearing claim is the one these tests exist for:
 *
 * > **"We could not check" and "we checked and found nothing" are different
 * > answers, and a reader who cannot tell them apart concludes their site is fine.**
 */

type Report = Parameters<typeof readinessHeadline>[0];

function report(overrides: Partial<NonNullable<Report>> = {}) {
  return {
    summary: "One thing to fix first.",
    whyNoScore:
      "A blocked crawler and perfect content average to a healthy-looking middle, so we do not give you a single number.",
    fixes: [],
    coverage: [],
    unavailable: [],
    ...overrides,
  };
}

const FIX = {
  id: "crawler-blocked",
  kind: "switch",
  fix: "Allow GPTBot in robots.txt",
  because: "Nothing else works until AI agents can read the site.",
  example: "User-agent: GPTBot\nAllow: /",
  order: 0,
};

describe("readinessHeadline", () => {
  it("says the report is unavailable rather than showing an empty list", () => {
    const headline = readinessHeadline(null);

    expect(headline.kind).toBe("unavailable");
    // **Explicitly not the clean phrasing.** A missing report is an absence of
    // evidence, and evidence we do not have is not evidence that nothing is wrong.
    expect(headline.message).toContain("could not finish this check");
    expect(headline.message).not.toMatch(/nothing to change/i);
  });

  it("reports a finished-and-clean audit as its own thing", () => {
    const headline = readinessHeadline(report());

    expect(headline.kind).toBe("clean");
    expect(headline.message).toMatch(/nothing to change/i);
  });

  it("never produces the clean phrasing for a missing report", () => {
    // The two branches are separate functions of one input, so this asserts the
    // distinction holds rather than trusting that they differ.
    const missing = readinessHeadline(null);
    const clean = readinessHeadline(report());

    expect(missing.kind).not.toBe(clean.kind);
    expect(missing.message).not.toBe(clean.message);
  });

  it("counts the fixes and pluralises on the count", () => {
    // **Whole-object assertions, not `toMatchObject`.** A partial matcher only
    // checks the keys it names, so `label: "fixes"` on the single-fix case
    // passed — the key was present and the *value* was never compared. The axis
    // was not pinned at all until this said `toEqual`, which is what a mutation
    // caught.
    //
    // "1 fixes" is the kind of small wrongness that costs a reader their
    // confidence in the whole report.
    expect(readinessHeadline(report({ fixes: [FIX] }))).toEqual({
      kind: "fixes",
      count: 1,
      label: "fix",
      message: "One thing to fix first.",
    });
    expect(readinessHeadline(report({ fixes: [FIX, FIX, FIX] }))).toEqual({
      kind: "fixes",
      count: 3,
      label: "fixes",
      message: "One thing to fix first.",
    });
  });

  it("carries the run's own summary through for the fixes case", () => {
    // The summary is the server's sentence, not one written here — the panel has
    // no opinion about what the site needs.
    const headline = readinessHeadline(
      report({ fixes: [FIX], summary: "Crawlability first, then structure." }),
    );
    expect(headline.message).toBe("Crawlability first, then structure.");
  });
});

describe("coverageNote", () => {
  it("says nothing at all when the run checked everything", () => {
    // **A permanent "some checks may not have run" line trains readers to ignore
    // the ones that matter**, so a complete report must look finished.
    expect(coverageNote(report())).toBeNull();
  });

  it("counts coverage lines and unavailable notes together", () => {
    const note = coverageNote(
      report({
        coverage: ["robots.txt was read", "llms.txt was fetched"],
        unavailable: [
          { what: "3 of 50 pages", because: "they could not be analysed" },
        ],
      }),
    );

    expect(note).toMatchObject({ kind: "caveats", count: 3 });
    expect(note?.kind === "caveats" && note.lines).toContain(
      "3 of 50 pages — they could not be analysed",
    );
  });

  it("reports an unreadable coverage column as unknown, not as a short list", () => {
    // **A corrupt column is not an empty one.** Null says "we cannot tell you what
    // we checked", which is the truth — and reporting it as a caveats list would
    // understate the gap.
    const note = coverageNote(report({ coverage: null }));

    expect(note).toEqual({ kind: "unknown" });
  });

  it("preserves a genuinely empty coverage list as no caveats", () => {
    // The counterpart: `[]` *is* a real answer, and treating it as unknown would
    // claim we could not read a column we read perfectly.
    expect(coverageNote(report({ coverage: [] }))).toBeNull();
  });
});

describe("fixBorderRule", () => {
  it("gives a switch the loudest edge, because it is a precondition", () => {
    // A reader should be able to find the blocking problem without reading every
    // row, which is what the left border is for.
    expect(fixBorderRule("switch")).toBe("border-l-error");
  });

  it("gives convention and quality different but not-severe edges", () => {
    // **A third colour would imply a severity the report does not claim**: how to
    // fix something is a matter of taste, not of consequence.
    expect(fixBorderRule("convention")).toBe("border-l-warning");
    expect(fixBorderRule("quality")).toBe("border-l-base-content/20");
  });

  it("falls back to the quiet edge for a kind it does not know", () => {
    // A new kind from the server must not render as a precondition.
    expect(fixBorderRule("something-new")).toBe("border-l-base-content/20");
  });
});
