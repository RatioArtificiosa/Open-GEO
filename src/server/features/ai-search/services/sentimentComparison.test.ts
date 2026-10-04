import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareSentiment,
  findCombiningSentiment,
} from "./sentimentComparison";

/**
 * CL-306's guard.
 *
 * The value of this feature is the *gap* between two measurements, and the
 * fastest way to destroy it is to hand someone one number. So most of this
 * file is about what must never exist.
 */

const WEB_BASIS =
  "Pages citing the keyword in DataForSEO's index, classified by the vendor.";
const AI_BASIS =
  "AI engine answers about the brand, classified by the vendor. Not pages.";

function both(overrides?: { web?: number | null; ai?: number | null }) {
  // `"web" in overrides`, not `??`: `null ?? 0.8` is `0.8`, so a fixture
  // written with `??` can never express the case it exists to test — and the
  // first version of this file did exactly that, which is why the missing-side
  // test passed against code that never saw a null. Same shape as the
  // `overrides.x ?? default` fixture bug the evidence-drawer suite hit.
  const web = overrides && "web" in overrides ? overrides.web! : 0.8;
  const ai = overrides && "ai" in overrides ? overrides.ai! : 0.4;
  return compareSentiment({
    keyword: "crm software",
    webPositiveShare: web,
    webCounts: { positive: 800, negative: 120, neutral: 80 },
    webBasis: WEB_BASIS,
    aiPositiveShare: ai,
    aiCounts: { positive: 40, negative: 55, neutral: 5 },
    aiBasis: AI_BASIS,
  });
}

describe("compareSentiment", () => {
  it("names a direction in words, never as a number", () => {
    const result = both();

    expect(result.direction).toBe("colder");
    // The gap is 0.4 and nothing in the payload offers it as a figure. A
    // percentage across two different denominators would be arithmetic
    // wearing a percentage sign.
    expect(JSON.stringify(result)).not.toMatch(/gap|difference|delta/i);
    expect(result.summary).toMatch(/colder than the web reading/i);
  });

  it("calls close readings similar rather than inventing a direction", () => {
    // Two shares inside the band are not a finding. A chart drawing a
    // confident arrow across one point is manufacturing a conclusion.
    const result = both({ web: 0.5, ai: 0.52 });

    expect(result.direction).toBe("similar");
    expect(result.summary).toMatch(/close enough to be indistinguishable/i);
  });

  it("keeps both sides, each with its own denominator", () => {
    const result = both();

    expect(result.web.basis).toBe(WEB_BASIS);
    expect(result.ai.basis).toBe(AI_BASIS);
    expect(result.web.basis).not.toBe(result.ai.basis);
  });

  it("says comparable is false, so nothing can infer it from silence", () => {
    expect(both().comparable).toBe(false);
  });

  it("refuses to compare when one side is missing, rather than treating it as zero", () => {
    // "We classified nothing" and "we classified everything as neutral" are
    // different findings, and only the second supports a direction.
    const noWeb = both({ web: null });
    expect(noWeb.direction).toBeNull();
    expect(noWeb.web.unavailable).toBe(true);
    expect(noWeb.summary).toMatch(/no reading for the open web/i);
    expect(noWeb.summary).not.toMatch(/colder|warmer/);

    const noAi = both({ ai: null });
    expect(noAi.direction).toBeNull();
    expect(noAi.ai.unavailable).toBe(true);
  });

  it("states that the two figures are deliberately not combined", () => {
    expect(both().summary).toMatch(/deliberately not combined/i);
  });
});

describe("the shape that forbids combining them", () => {
  // The rule is a pure function so a control can feed it a fixture instead of
  // the repository. `gates-about-gates` counts a negative control only when the
  // block builds its own fixture *and* does not read the live tree, because a
  // scan over the working copy passes identically when the scanner matches
  // nothing at all.
  it("finds no combining arithmetic in this module", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/server/features/ai-search/services/sentimentComparison.ts",
      ),
      "utf8",
    );
    expect(findCombiningSentiment(source)).toEqual([]);
  });

  it("would catch a blend written inline", () => {
    // **The negative control.**
    //
    // Shaped to the survey's own recogniser, which counts a control only when
    // the block (a) asserts a *finding* in a shape it recognises — `toBe(true)`
    // or `toHaveLength(greaterThan(…))`, never `not.toEqual([])` — and (b) builds
    // an inline fixture without reading the repository. The first version of
    // this control used `not.toEqual([])` and was reported as a gate with no
    // control at all, while a hand-written copy of the recogniser cheerfully
    // counted it. **A control the survey cannot see is not a control**, so the
    // assertion is written in its language.
    //
    // `platform-card-rule` refuses to sum demand across AI platforms; this is
    // the same mistake one level out — across *measurement types* — and that
    // gate's patterns are platform collections and demand fields, so it cannot
    // see this one.
    const theBugThatWouldShip = [
      "const blended = ((web.share ?? 0) + (ai.share ?? 0)) / 2;",
      "return { blended, direction: directionOf(web.share, ai.share) };",
    ].join("\n");
    const offenders = findCombiningSentiment(theBugThatWouldShip);
    expect(offenders.length > 0).toBe(true);
    expect(offenders[0]).toBeTruthy();
  });

  it("would catch a blend written through a sum helper", () => {
    // The form the CL-132 scan actually found live, one module over.
    const viaHelper = [
      "const blended = sumNullable([web.share, ai.share]);",
      "const direction = directionOf(web.share, ai.share);",
    ].join("\n");
    expect(findCombiningSentiment(viaHelper)).not.toEqual([]);
  });

  it("would catch a single blended field under a plausible name", () => {
    // The blend would more often arrive as a field than as an obvious sum,
    // and a name is all the difference between a scanner seeing it and not.
    const namedField = [
      "const result = { blendedShare: 0.6, comparable: false };",
      "return result;",
    ].join("\n");
    expect(findCombiningSentiment(namedField)).not.toEqual([]);
  });

  it("does not flag the worded direction, which is the whole point", () => {
    // **The false positive that nearly shipped the gate.** `directionOf(web.share,
    // ai.share)` mentions both sides, and an earlier version flagged any
    // binding that did — reporting six, every one legitimate, including this
    // line. A gate that fires on correct code teaches people to ignore it,
    // which is the failure `platform-card-rule` recorded twice while finding
    // its patterns.
    const wordedOnly = [
      "const direction = directionOf(web.share, ai.share);",
      "const summary = `web ${web.share} vs ai ${ai.share}`;",
    ].join("\n");
    expect(findCombiningSentiment(wordedOnly)).toEqual([]);
  });

  it("does not read the prose that explains the rule as code", () => {
    // The summary sentence contains a `/` and two `${pct(webShare)}` holes. An
    // earlier version reported two violations from that one string — both
    // false, both from the sentence written to explain the rule. Literals are
    // blanked before scanning, which is what makes this a check of code.
    const proseWithSlashes = [
      "const summary = `The open web classifies ${pct(webShare)} of citing",
      "  pages as positive; the AI reading is ${pct(aiShare)}.`;",
      "return { summary };",
    ].join("\n");
    expect(findCombiningSentiment(proseWithSlashes)).toEqual([]);
  });

  it("types comparable as the literal false, not as a boolean", () => {
    // `comparable: false` as a type means flipping it is a type error at the
    // declaration rather than a review question at the use site.
    const source = readFileSync(
      join(
        process.cwd(),
        "src/server/features/ai-search/services/sentimentComparison.ts",
      ),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).toMatch(/comparable:\s*false;/);
  });
});
