/**
 * The AI Demand Explorer table: AI volume × Google volume × intent × KD.
 *
 * This is the surface where the product's central claim finally has to be
 * *executed* rather than obeyed. Every other place that touches these two
 * numbers refuses to combine them — the summed demand card (CL-212a), the
 * combined visibility score, the SOV demand row. The claim itself is the
 * opposite: **a keyword with high AI demand and low Google demand is invisible
 * to classic SEO and is often the cheapest traffic available.** That is the
 * product's reason to exist, and it is a *ratio* of the two units.
 *
 * ## Why a ratio is allowed where a sum was banned
 *
 * The ban is on **addition**, not on comparison. Adding
 * 12,621,380 Google searches to 63,850 People-Also-Ask-modelled queries produces
 * a number whose units are meaningless. Dividing one by the other produces a
 * *dimensionless* quantity that means something precise and checkable: "for
 * every real search, there are N modelled AI queries." The sum had no such
 * property; the ratio does.
 *
 * The rules that follow from that:
 *
 * - **The ratio is directional and named.** `aiToGoogle` is explicitly
 *   AI-over-Google. The inverse is a different number and is not offered, because
 *   a reader who flips it gets a number that looks small and means "rarely asked
 *   in AI" — true, but the opposite decision.
 * - **Google volume of zero is a division by zero.** It is also, and much more
 *   interestingly, the *best possible* result: a keyword nobody searches on
 *   Google but AI answers ask about constantly. So it is reported as
 *   `infinite`, named as such, and sorted to the top — not as null, and not as
 *   zero.
 * - **AI volume of zero is `null`, not zero.** We asked and the answer was
 *   nothing, which is a finding. Google's zero is *also* a finding, and the two
 *   are opposite facts that happen to share a value.
 */

/** Google's real search volume, and the classic-SEO fields beside it. */
export type GoogleKeywordRow = {
  keyword: string;
  /** Real Google search volume. 0 means nobody searches this. */
  searchVolume: number | null;
  /** 0–100, DataForSEO's scale. Not comparable to anything else on this table. */
  keywordDifficulty: number | null;
  /** e.g. "informational", "commercial". Provider's label, not ours. */
  intent: string | null;
};

/** AI demand, from `ai_keyword_data/keywords_search_volume`. */
export type AiKeywordRow = {
  keyword: string;
  /**
   * Modelled AI demand. **Not** comparable to Google's figure — this is the
   * People-Also-Ask-derived estimate, not a count of anything observable.
   */
  aiSearchVolume: number | null;
};

type DemandRow = {
  keyword: string;
  googleVolume: number | null;
  aiVolume: number | null;
  keywordDifficulty: number | null;
  intent: string | null;
  /**
   * AI demand per real Google search. `null` when Google volume is unknown;
   * `"infinite"` when Google volume is a measured zero; never summed or
   * averaged with anything.
   */
  aiToGoogle: number | "infinite" | null;
  /**
   * Why the ratio is missing, in words. The whole table is built on the claim
   * that AI demand is where the opportunity is, so a silently-null ratio is a
   * row that silently argues against the product's own thesis.
   */
  aiToGoogleNote: string;
  /**
   * The headline finding for this row, or null when the row says nothing
   * actionable. Deliberately not a score — a score would invite ranking, and
   * ranking across keywords with different KDs is a decision the user makes.
   */
  opportunity: string | null;
};

type DemandTable = {
  rows: DemandRow[];
  /** Keywords requested that neither side returned data for. */
  missing: string[];
  summary: string;
};

/**
 * Join AI demand onto Google demand.
 *
 * `aiRows` and `googleRows` are joined on the **normalised** keyword (trimmed,
 * lowercased) — the form both clients submit — because DataForSEO lowercases
 * server-side and returns its own form. A naive `===` join silently drops every
 * row whose casing differs, which reads as "no AI data" rather than "join bug".
 */
export function buildDemandTable(input: {
  aiRows: AiKeywordRow[];
  googleRows: GoogleKeywordRow[];
}): DemandTable {
  const aiByKeyword = new Map<string, AiKeywordRow>();
  for (const row of input.aiRows) {
    aiByKeyword.set(normalise(row.keyword), row);
  }

  const rows: DemandRow[] = [];
  const missing: string[] = [];

  for (const google of input.googleRows) {
    const key = normalise(google.keyword);
    const ai = aiByKeyword.get(key);
    if (ai === undefined) missing.push(google.keyword);

    const aiVolume = ai?.aiSearchVolume ?? null;
    const { ratio, note } = computeAiToGoogle(aiVolume, google.searchVolume);
    const row: DemandRow = {
      keyword: google.keyword,
      googleVolume: google.searchVolume,
      aiVolume,
      keywordDifficulty: google.keywordDifficulty ?? null,
      intent: google.intent ?? null,
      aiToGoogle: ratio,
      aiToGoogleNote: note,
      opportunity: describeOpportunity({
        keyword: google.keyword,
        ratio,
        aiVolume,
        googleVolume: google.searchVolume,
      }),
    };
    rows.push(row);
  }

  const table: DemandTable = { rows: [], missing, summary: "" };
  // The table's whole purpose is the strongest rows, and `infinite` must sort
  // above any finite ratio rather than below it.
  table.rows = rankRows(rows);
  table.summary = describe(table);
  return table;
}

function normalise(keyword: string): string {
  return keyword.trim().toLowerCase();
}

type Ratio = DemandRow["aiToGoogle"];

function computeAiToGoogle(
  aiVolume: number | null,
  googleVolume: number | null,
): { ratio: Ratio; note: string } {
  if (aiVolume === null) {
    return {
      ratio: null,
      note: "No AI demand was returned for this keyword, so there is no ratio to compare against Google.",
    };
  }
  if (googleVolume === null) {
    return {
      ratio: null,
      note: "Google volume is unknown, so there is no denominator. An unknown is not a zero.",
    };
  }
  if (googleVolume === 0) {
    // The interesting case, and the one a naive implementation gets wrong by
    // returning 0 or Infinity. It is neither: nobody searches this on Google,
    // and AI answers ask about it — which is the product's thesis, exactly.
    return {
      ratio: "infinite",
      note: "Nobody searches this on Google, so AI demand per search is unbounded. This is the strongest possible result, not a missing one.",
    };
  }
  if (aiVolume === 0) {
    return {
      ratio: 0,
      note: "AI engines report no demand for this keyword while Google does — the reverse opportunity, and one no classic SEO tool would surface.",
    };
  }
  return {
    ratio: aiVolume / googleVolume,
    note: "AI demand per real Google search. The two figures are different units, so this is a comparison, never a total.",
  };
}

/**
 * Ascending sort key for one row: unbounded first, then the strongest finite
 * ratio, then everything unrankable.
 *
 * Module-level rather than a closure inside `rankRows` — it captures nothing, and
 * a function that does not close over anything is easier to test directly.
 */
function rankOf(row: DemandRow): number {
  if (row.aiToGoogle === "infinite") return Number.NEGATIVE_INFINITY;
  if (row.aiToGoogle === null) return Number.MAX_SAFE_INTEGER;
  return -row.aiToGoogle;
}

function rankRows(rows: DemandRow[]): DemandRow[] {
  // Plain insertion sort: `no-array-sort` forbids `sort` and the spread form,
  // and the `lib` target predates `toSorted`. The ordering *is* the product
  // feature — "unbounded first, then strongest ratio, then unrankable last".
  const ordered: DemandRow[] = [];
  for (const row of rows) {
    let at = ordered.length;
    for (let i = 0; i < ordered.length; i += 1) {
      const other = ordered[i];
      if (other !== undefined && rankOf(other) > rankOf(row)) {
        at = i;
        break;
      }
    }
    ordered.splice(at, 0, row);
  }
  return ordered;
}

function describeOpportunity(input: {
  keyword: string;
  ratio: Ratio;
  aiVolume: number | null;
  googleVolume: number | null;
}): string | null {
  const { ratio, aiVolume } = input;
  if (ratio === "infinite") {
    return `Nobody searches "${input.keyword}" on Google and AI engines still ask about it — usually the cheapest win on this table.`;
  }
  if (ratio === null || aiVolume === null) return null;
  if (ratio >= 1) {
    return `AI engines ask about "${input.keyword}" more than Google does. Classic SEO tools will not show this.`;
  }
  if (ratio > 0) {
    return `AI demand for "${input.keyword}" is ${(ratio * 100).toFixed(1)}% of its Google volume — a modest, real signal.`;
  }
  return null;
}

function describe(table: DemandTable): string {
  const ranked = table.rows.filter((r) => r.aiToGoogle !== null);
  if (ranked.length === 0) {
    return "No keyword could be compared: we have no AI demand or no Google volume to compare it against.";
  }
  const infinite = table.rows.filter((r) => r.aiToGoogle === "infinite").length;
  const gap = table.missing.length;
  return (
    `${ranked.length} of ${table.rows.length} keywords had both figures. ` +
    `${infinite} are unsearched on Google but asked about in AI. ` +
    (gap > 0 ? `${gap} had no AI data and are listed without a ratio. ` : "") +
    `The ratio is a comparison of two different units — it is never added to anything, and it is not a score.`
  );
}
