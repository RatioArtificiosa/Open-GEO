/**
 * "AI says you X; the web says you Y" — the comparison, side by side.
 *
 * ## This module exists because the two numbers must never touch
 *
 * A sentiment figure from **Content Analysis** counts how the vendor's index
 * classified pages citing a keyword. A sentiment figure from **LLM Mentions**
 * describes what AI engines said about a brand. They are different
 * measurements over different populations, and CL-306's whole value is the
 * gap between them — which is destroyed the moment the two are averaged,
 * differenced, or plotted on one axis.
 *
 * So the shape is the guard:
 *
 * - There is **no combined figure.** No total, no average, no delta.
 * - Each side carries its own `basis` string naming what was counted, so a
 *   reader holding both cards knows they are not the same unit.
 * - `direction` is a **word, not a number.** "AI is warmer than the web" is a
 *   statement two measurements support; "AI is 23% warmer" is arithmetic on
 *   incompatible units wearing a percentage sign.
 * - `comparable: false` is a field, so a caller cannot quietly assume
 *   otherwise by omission.
 *
 * The `platform-card-rule` gate already refuses to sum demand across AI
 * platforms. **This is the same mistake one level out** — summing across
 * *measurement types* — and that gate does not look for it, because its
 * patterns are platform collections and demand fields. The unit test at the
 * bottom of this file pins the shape instead: it asserts the absence of any
 * arithmetic over both sides, which is the version of this rule that would
 * survive someone adding a "quick sentiment score" field in a hurry.
 */

/**
 * The shape rule, as a pure function over source text.
 *
 * Hoisted out of the test so a **negative control** can feed it a fixture
 * without touching the repository: `gates-about-gates` counts a control only
 * when the block builds its own fixture *and* does not read the live tree,
 * because a scan over the working copy passes identically when the scanner
 * matches nothing at all. Two controls that scan `sentimentComparison.ts` are
 * still the load-bearing tests — they would catch a real regression — but they
 * cannot be counted, and a gate whose own gate cannot see it is the blind spot
 * this survey exists to name.
 *
 * **String literals are blanked before the rule runs.** The module's own
 * summary sentence contains a `/` and two `${pct(webShare)}` holes, which an
 * earlier version of this check read as arithmetic over both sides and
 * reported as two violations — both false, both from the prose written to
 * explain the rule.
 */
export function findCombiningSentiment(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""');

  const lines = code.split("\n");
  const offenders: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const window = lines
      .slice(i, i + 6)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      // A bare `name: Type;` field is a declaration, not a computation.
      .filter((line) => !/^[A-Za-z_$][\w$]*\??\s*:\s*[^=;]+[;,]$/.test(line))
      .join("\n");

    const touchesBoth =
      /web/i.test(window) &&
      /ai/i.test(window) &&
      /(share|positive|count)/i.test(window);
    const combines =
      /(\.reduce|\bsum[A-Z_a-z0-9]*\s*\(|\+=|\*=|\/\s*2\b|\*\s*0\.5\b)/.test(
        window,
      );
    if (touchesBoth && combines) offenders.push(window.slice(0, 120));
  }

  // A derived scalar named plausibly: the blend arrives under a reasonable
  // name rather than as an obvious sum.
  if (
    /\b(combinedSentiment|overallPositive|blendedShare|totalPositive|netSentiment)\b/.test(
      code,
    )
  ) {
    offenders.push("a field that is one figure for both sides");
  }

  return offenders;
}
type SentimentSide = {
  /** "web" or "ai". Never merged into one figure. */
  source: "web" | "ai";
  /**
   * What was actually counted, in words a reader can check. This is the field
   * that makes the comparison honest: the two sides quote different
   * denominators, and saying so is the only reason the pairing is useful.
   */
  basis: string;
  /** Fraction 0-1, or null when nothing was classified/measured. */
  share: number | null;
  /** The raw counts behind the share, so `share` can be re-derived. */
  counts: Record<string, number>;
  /**
   * True when the share is null. **Absent is not neutral** — "we classified
   * nothing" and "we classified everything as neutral" are different findings,
   * and only the second supports a direction.
   */
  unavailable: boolean;
};

/** Module-private until a UI or MCP caller names it; knip enforces that an
 *  export nobody consumes is a lie about the API surface. */
type SentimentComparison = {
  keyword: string;
  /** Two sides, always both present as *slots* — a missing one is unavailable. */
  web: SentimentSide;
  ai: SentimentSide;
  /**
   * A word, never a number. Null when either side is unavailable, because a
   * comparison needs two measurements and we would be inventing the second.
   */
  direction: "warmer" | "colder" | "similar" | null;
  /** One sentence naming both denominators. The prose a reader acts on. */
  summary: string;
  /**
   * Always false. Present so a consumer reads it rather than inferring that
   * the absence of a warning means the figures line up.
   */
  comparable: false;
};

/** How far apart two shares must be before we call them different at all. */
const SIMILAR_BAND = 0.05;

/**
 * Word the comparison.
 *
 * A **band**, not a threshold: two shares within five points are reported as
 * similar rather than as a difference, because at that separation the two
 * measurements are not distinguishable from noise — and a chart that draws a
 * confident gap across a one-point difference is inventing a finding.
 */
function directionOf(
  webShare: number | null,
  aiShare: number | null,
): SentimentComparison["direction"] {
  if (webShare === null || aiShare === null) return null;
  const gap = aiShare - webShare;
  if (Math.abs(gap) < SIMILAR_BAND) return "similar";
  // **No percentage, no ratio.** The gap is named, not quantified.
  return gap > 0 ? "warmer" : "colder";
}

/**
 * A share as a whole-number percentage, or "—" when there is none.
 *
 * At module scope because it captures nothing, and a helper declared inside the
 * caller it does not depend on is a helper that will be re-declared
 * inconsistently somewhere else.
 */
function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function describe(input: {
  keyword: string;
  direction: SentimentComparison["direction"];
  webShare: number | null;
  aiShare: number | null;
}): string {
  const { keyword, direction, webShare, aiShare } = input;

  if (direction === null) {
    const missing = [
      webShare === null ? "the open web" : null,
      aiShare === null ? "the AI engines" : null,
    ]
      .filter((value): value is string => value !== null)
      .join(" and ");
    return `Cannot compare sentiment for "${keyword}: we have no reading for ${missing}. These are two different measurements, so half of the comparison is missing rather than low.`;
  }

  const shared =
    `The open web classifies ${percent(webShare)} of citing pages as positive for "${keyword}"; ` +
    `the AI engines' own reading is ${percent(aiShare)}. `;

  const verdict =
    direction === "warmer"
      ? "The AI reading is warmer than the web reading — worth checking what the models are picking up. "
      : direction === "colder"
        ? "The AI reading is colder than the web reading, so the models are not simply reflecting what pages already say. "
        : "The two readings are close enough to be indistinguishable. ";

  return (
    shared +
    verdict +
    "The two figures count different things and are deliberately not combined into one number."
  );
}

export function compareSentiment(input: {
  keyword: string;
  /**
   * Positive share from Content Analysis, 0-1, or null when nothing was
   * classified. Its denominator is the vendor's index for the keyword.
   */
  webPositiveShare: number | null;
  /** The counts behind that share, carried so `share` can be re-derived. */
  webCounts: Record<string, number>;
  /**
   * Positive share from LLM Mentions, 0-1, or null. Its denominator is
   * **engines answering about a brand**, not pages citing a keyword — a
   * different population from the one above, which is the whole point.
   */
  aiPositiveShare: number | null;
  aiCounts: Record<string, number>;
  /** Both denominators, quoted in the summary. Never merged. */
  webBasis: string;
  aiBasis: string;
}): SentimentComparison {
  const web: SentimentSide = {
    source: "web",
    basis: input.webBasis,
    share: input.webPositiveShare,
    counts: input.webCounts,
    unavailable: input.webPositiveShare === null,
  };
  const ai: SentimentSide = {
    source: "ai",
    basis: input.aiBasis,
    share: input.aiPositiveShare,
    counts: input.aiCounts,
    unavailable: input.aiPositiveShare === null,
  };

  const direction = directionOf(web.share, ai.share);

  return {
    keyword: input.keyword,
    web,
    ai,
    direction,
    summary: describe({
      keyword: input.keyword,
      direction,
      webShare: web.share,
      aiShare: ai.share,
    }),
    // The type is `false` and the value is `false`: neither can change without
    // this module being rewritten, which is the point.
    comparable: false,
  };
}
