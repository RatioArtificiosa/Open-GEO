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
/**
 * Does this expression combine two shares into one number?
 *
 * **Any division, not just `/ 2`.** An earlier version matched `/\s*2\b/`, which
 * caught the careless `(a + b) / 2` and walked past `(a + b) / total` — the
 * weighted blend, which is what someone writes when they are being careful
 * about it. A rule that only catches the careless version of a mistake
 * survives the careful version, which is the one that ships.
 *
 * The window is bounded rather than the whole file, and the bound is what
 * caused two rounds of false positives here: a regex literal is code, so
 * `/\/\*[\s\S]*?\*\//g` reads as a division, and this module's own blanking
 * chain is flagged by the rule living inside it. Rather than enumerate the
 * shapes that are not arithmetic, the window must contain **both sides and an
 * arithmetic operator**, and a `.replace(/regex/` chain contains neither side.
 */
function combinesTwoShares(window: string): boolean {
  if (/(\.reduce|\bsum[A-Z_a-z0-9]*\s*\()/.test(window)) return true;
  if (/(\+=|\*=)/.test(window)) return true;
  // A `/` with an operand on both sides: `a / b`, `) / 1`, `(a + b) / total`.
  return /\S\s*\/\s*[(\dA-Za-z_$]/.test(window);
}

/**
 * Strip everything that is not executable code — comments, string literals and
 * regex literals — for a caller reading a **file**.
 *
 * The regex half is what this needed after four attempts. A regex literal is
 * code to a substring scan, so `/\/\*[\s\S]*?\*\//g` reads as a division and
 * `[ai]` reads as the `ai` side — and the rule ended up flagging the module
 * that defines it while missing `(web.share + ai.share) / 2`, which is the
 * defect it exists to catch. Patching the side patterns made the false
 * positives worse and the true negatives worse at the same time.
 *
 * The generalisable part: **a source scan has to decide what is code, and a
 * pattern that only handles the delimiter kinds it has already met will
 * misreport its own source.** Comments and strings were handled; regexes were
 * the third kind, missed by someone who had only written regexes into *other*
 * files. `platform-card-rule` has the same shape and the same note about its
 * own `strip`.
 */
export function blankNonCode(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (two === "//") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    const ch = source[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipLiteral(source, i, ch);
      continue;
    }
    // A regex literal opens with a `/` that cannot follow an operand;
    // division always does. That is the only reliable discriminator, and it
    // is why this scans statefully rather than with a pattern.
    if (ch === "/" && !/[\w$)\]]/.test(source[i - 1] ?? " ")) {
      i = skipRegex(source, i);
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Past the end of a quoted or backticked literal starting at `start`.
 *
 * **Template holes are kept**, because `${pct(webShare)}` is executable and
 * blanking it would hide the arithmetic the rule exists to find. That is the
 * one place a "blank the literal" rule has to stop, and getting it wrong in
 * either direction produces a gate that misses the defect or flags prose.
 */
function skipLiteral(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (quote === "`" && c === "$" && source[i + 1] === "{") {
      i = skipTemplateHole(source, i + 1);
      continue;
    }
    i += 1;
  }
  return source.length;
}

/** Past the closing `}` of a `${…}` hole, keeping everything inside it. */
function skipTemplateHole(source: string, braceAt: number): number {
  let depth = 0;
  let i = braceAt;
  while (i < source.length) {
    const c = source[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return source.length;
}

/** Past the closing `/` and flags of a regex literal opening at `start`. */
function skipRegex(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i + 1;
    else if (c === "\n") break;
    i += 1;
  }
  return i;
}

export function findCombiningSentiment(source: string): string[] {
  // **The `source` argument is code, verbatim.** It is not run through
  // `blankNonCode`: that would blank the string literals of a *fixture*, whose
  // whole content is a blend written as a string, and a rule that discards its
  // own input reports "clean" on the defect it was built to find. Callers
  // reading a file pass file contents; callers passing a fixture pass the
  // fixture text, which is code by definition.
  const code = source;

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

    // Both sides, a share-shaped field, and arithmetic. Regex literals and
    // string literals are already blanked, so a plain substring test is safe
    // here — the identifier-shaped patterns that replaced it missed
    // `aiShare`, which is exactly the form a real blend is written in.
    const mentionsBoth = /web/i.test(window) && /ai/i.test(window);
    const shareField = /(share|positive|count)/i.test(window);
    if (mentionsBoth && shareField && combinesTwoShares(window)) {
      offenders.push(window.slice(0, 120));
    }
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
  /** The caller's own statement of what each side counted. */
  webBasis: string;
  aiBasis: string;
}): string {
  const { keyword, direction, webShare, aiShare, webBasis, aiBasis } = input;

  if (direction === null) {
    const missing = [
      webShare === null ? "the open web" : null,
      aiShare === null ? "the AI engines" : null,
    ]
      .filter((value): value is string => value !== null)
      .join(" and ");
    return `Cannot compare sentiment for "${keyword}": we have no reading for ${missing}. These are two different measurements, so half of the comparison is missing rather than low.`;
  }

  // **The bases are the caller's, not prose written here.** Each side names
  // what it counted, and the summary quotes those names — so a reader holding
  // both figures learns *why* they are not comparable from the sentence
  // itself, rather than being told they are not comparable while the sentence
  // quietly asserts a denominator nobody chose.
  const shared =
    `The open web classifies ${percent(webShare)} as positive for "${keyword}" — ${webBasis} ` +
    `The AI engines' own reading is ${percent(aiShare)} — ${aiBasis} `;

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
      webBasis: input.webBasis,
      aiBasis: input.aiBasis,
    }),
    // The type is `false` and the value is `false`: neither can change without
    // this module being rewritten, which is the point.
    comparable: false,
  };
}
