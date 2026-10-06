import { sortBy } from "remeda";
import { normalisePrompt } from "@/shared/prompt-normalisation";
import type { GeoPromptIntent } from "@/server/features/geo/repositories/GeoSetupRepository";

/**
 * The prompt-set generator: what a queued GEO run should ask.
 *
 * ## The problem this solves
 *
 * A queued run posts **the project's saved questions** (`promptsForQueuedRun`), and
 * until now nothing proposed any. So the cheapest acquisition path — ~30% cheaper,
 * up to 72 hours slower — needed an owner to think of a good prompt set from a
 * blank textarea, and the run posts nothing while they do not.
 *
 * ## The three seeds, and why they are not equal
 *
 * 1. **Mention questions** are prompts the vendor has *already* asked about this
 *    brand. They are the only entries in the set whose language is observed rather
 *    than composed, so they are kept **verbatim**, ranked first, and never
 *    rephrased. A generator that rewrote them would be replacing evidence with a
 *    template.
 * 2. **AI keyword demand** (`ai_keyword_data`, cached) says *which topics* are worth
 *    asking about — and it is the only seed that ranks. It is AI-specific demand,
 *    which is the point: a topic with AI demand and no Google demand is invisible to
 *    classic SEO tools (see the `what-to-build` skill).
 * 3. **Search intent** turns a keyword into a *question*, because what a run must
 *    post is a question. Intent comes from the classification the product already
 *    caches per keyword, so no model call happens here and the cost is zero.
 *
 * ## What the templates are, and what they are not
 *
 * The four per-intent phrasings below are **starting points for the owner to edit**,
 * not claims about how every buyer talks. The whole surface is a textarea with a
 * Generate button for exactly that reason: this proposes a *draft* set, and a draft
 * nobody edits would be a machine's guess about a customer's market shipped as
 * their voice. What the generator contributes is the *ranking* and the *coverage* —
 * which is the part that is tedious by hand and checkable by machine.
 *
 * ## Two rules that come from money, not taste
 *
 * - **Duplicate questions are one question.** The run bills per prompt, and
 *   `promptsForQueuedRun` already drops duplicates before posting; two entries that
 *   differ only by case or a double space would be *two rows in the editor* and one
 *   question posted, which reads as a bug. Normalisation is the same one the AI
 *   keyword client uses, because it is the same join problem.
 * - **`null` demand is not zero demand.** A keyword the archive holds no volume for
 *   is still a topic the engines asked about; it becomes a prompt with
 *   `aiSearchVolume: null`, and it never outranks a measured number.
 */

export type PromptSeedKeyword = {
  keyword: string;
  /** The cached classification, or null when nothing has classified it yet. */
  intent: GeoPromptIntent | null;
  /** AI demand from `ai_keyword_data`, or null when the archive has none. */
  aiSearchVolume: number | null;
};

export type GeneratedPrompt = {
  prompt: string;
  intent: GeoPromptIntent;
  /**
   * Where the entry came from, so a reader can tell an observed question from a
   * composed one. This is provenance for the *editor*, not for the archive — the
   * saved row keeps only the prompt and its intent.
   */
  source: "mention" | "keyword";
  /** The demand that ranked a keyword entry; null for mentions and for no data. */
  aiSearchVolume: number | null;
};

/**
 * One phrasing per intent, each chosen for what that intent means.
 *
 * **A `Record` rather than a `switch` on purpose:** adding a fifth intent to the
 * database enum then fails to compile here, rather than silently producing no
 * prompt for every keyword carrying it — the failure mode this repository keeps
 * finding, where a new case is a gap nobody sees.
 *
 * **Each one is idempotent, and that is not decoration.** A keyword already in its
 * question form — `best ai tools`, `rank tracking pricing`, `acme reviews` — is left
 * alone. The naive template produces **"best best ai tools"**, which is what the
 * first version of this file did and what a test caught; a set full of doubled words
 * is a set nobody saves, and the owner would have to fix every line by hand, which
 * is the work the generator exists to remove.
 */
const TEMPLATES: Record<GeoPromptIntent, (keyword: string) => string> = {
  // "what is x" is the question form of wanting to understand a topic.
  informational: (keyword) =>
    /^what (is|are|does|do)\b/.test(keyword) ? keyword : `what is ${keyword}`,
  // "best x" is the question form of comparing options.
  commercial: (keyword) =>
    /^best\b/.test(keyword) ? keyword : `best ${keyword}`,
  // Cost is the last question before a purchase, and it is the one an
  // AI answer is most often cited for.
  transactional: (keyword) =>
    /\b(pricing|price|cost|cheap)\b/.test(keyword)
      ? keyword
      : `${keyword} pricing`,
  // Third-party opinion: reviews are where AI citations overwhelmingly live
  // (reddit, G2, capterra), which is the list's own thesis.
  navigational: (keyword) =>
    /\breviews?\b/.test(keyword) ? keyword : `${keyword} reviews`,
};

/**
 * The intent a keyword falls back to when nothing has classified it.
 *
 * `informational`, because "what is x" is the safest question to ask about an
 * unknown topic: it is answerable, it costs the same as any other prompt, and a
 * wrong *phrasing* wastes one call, where a wrong *claim about the buyer* would
 * have been a fabricated fact.
 */
const UNCLASSIFIED_INTENT: GeoPromptIntent = "informational";

/**
 * The default cap, and the reason it is a number at all.
 *
 * Every entry is a **billed vendor call per run**, so an uncapped generator is a
 * generator that can multiply someone's nightly spend from a single click — the
 * same asymmetry the nightly budget exists for. Twenty-five is also about the point
 * where a set stops being curated and becomes a list nobody reads, and the owner
 * can always add more by hand.
 */
export const DEFAULT_MAX_PROMPTS = 25;

/**
 * The dedupe key lives in `@/shared/prompt-normalisation`, because the **editor**
 * has to apply the same rule when a reader adds a line by hand — a second
 * implementation would drift, and the two would then disagree about whether the box
 * already contains a question.
 */

export function buildPromptSet(input: {
  /** Prompts the vendor has already asked about this brand, in the order given. */
  mentionQuestions: string[];
  /** Topics with AI demand, and whatever intent has been cached for each. */
  keywords: PromptSeedKeyword[];
  maxPrompts?: number;
}): GeneratedPrompt[] {
  const max = input.maxPrompts ?? DEFAULT_MAX_PROMPTS;
  if (max <= 0) return [];

  const seen = new Set<string>();
  const out: GeneratedPrompt[] = [];

  // Mentions first, verbatim, because they are the only observed language in the
  // set. A mention that repeats is dropped like anything else — the vendor asked
  // one question, however many times it appears in the archive.
  for (const question of input.mentionQuestions) {
    const prompt = question.trim().replace(/\s+/g, " ");
    const key = normalisePrompt(prompt);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push({
      prompt,
      intent: UNCLASSIFIED_INTENT,
      source: "mention",
      aiSearchVolume: null,
    });
  }

  // Then the keywords, by demand. Ranked rather than alphabetical because the
  // ranking IS the seed's contribution: the top of this list is where the AI
  // demand is, and a cap that took them alphabetically would cut exactly the
  // topics worth asking about.
  const ranked = sortBy(
    input.keywords,
    // A measured number always beats no data, and the tie-break is the keyword so
    // the same inputs always produce the same set.
    [(seed) => seed.aiSearchVolume !== null, "desc"],
    [(seed) => seed.aiSearchVolume ?? 0, "desc"],
    [(seed) => normalisePrompt(seed.keyword), "asc"],
  );

  for (const seed of ranked) {
    if (out.length >= max) break;
    const keyword = seed.keyword.trim().replace(/\s+/g, " ");
    if (keyword.length === 0) continue;
    const intent = seed.intent ?? UNCLASSIFIED_INTENT;
    const prompt = TEMPLATES[intent](keyword);
    const key = normalisePrompt(prompt);
    // A composed question that duplicates an observed one is dropped: the mention
    // is the better entry, and the run would ask it once either way.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      prompt,
      intent,
      source: "keyword",
      aiSearchVolume: seed.aiSearchVolume,
    });
  }

  return out.slice(0, max);
}
