/**
 * The answer diff, as a reader.
 *
 * **This is the moat, and the module has been built and tested since CL-209 with no
 * caller.** `diffAnswers` is a pure function over a `before`/`after` pair; nothing
 * in production has ever assembled that pair from the archive, so the one output
 * that is *impossible* without stored history has never been shown to anyone.
 *
 * ## Why a pair and not a series
 *
 * The diff answers one question: *what changed between these two captures*. A series
 * reader would have to choose which two, and every choice is a claim — the last
 * two, the two that moved most, the two a reader picked. So this takes the two a
 * caller names and refuses rather than inventing a baseline: **an answer with no
 * earlier capture has nothing to be compared against**, and saying "first capture,
 * no comparison yet" is the honest reading rather than diffing it against nothing.
 *
 * ## What it deliberately does not say
 *
 * Not *why* the answer changed. Models change for reasons we cannot observe — a
 * retraining, a sampling draw, a different query expansion — so presenting a citation
 * change as a consequence of what the customer did last week is a causal claim with
 * no evidence behind it, and it is how a reader attributes a loss to their own
 * content and stops trusting the product. `caveat` is always present.
 */
import { GeoAnswerRepository } from "@/server/features/geo/repositories/GeoAnswerRepository";
import { GeoSetupRepository } from "@/server/features/geo/repositories/GeoSetupRepository";
import { diffAnswers, type DiffAnswer, type DiffCitation } from "./answerDiff";
import { AppError } from "@/server/lib/errors";
import { isGeoPlatform } from "@/server/features/geo/repositories/GeoSetupRepository";
import { GEO_PLATFORMS } from "@/types/schemas/geo";

/**
 * The keyword identity this read joins on.
 *
 * **Deliberately the same normalisation the repository and the alert reader use**
 * (`trim().toLowerCase()`), because a diff computed across two spellings of one
 * question reports a change that never happened. A second copy would be a second
 * answer to "what is the same question", and the repo already has the rule that
 * there is exactly one.
 */
function normaliseKeyword(keyword: string): string {
  return keyword.trim().toLowerCase();
}

/**
 * One answer as the diff needs it.
 *
 * `citations` carries a **rank**, and that is why this is not a projection of the
 * archive: the diff distinguishes a page that moved from position 4 to 9, which is a
 * different finding from one that appeared. Without a rank the diff collapses to a
 * set difference and reports half of what it saw.
 */
function asDiffAnswer(row: { id: string; answeredAt: string }): DiffAnswer {
  return { id: row.id, answeredAt: row.answeredAt, citations: [] };
}

/**
 * The diff's shape, plus the two fields that exist only to say "there is nothing
 * to compare".
 *
 * **Not exported**, and knip is right to object when it was: the return type is
 * inferred at the call site, and an exported type nothing imports is a claim about
 * the API surface that is not true.
 */
type AnswerDiffResult = {
  /** The question both answers were to, verbatim. */
  prompt: string;
  /** How many captures exist for it, which is more than the two compared. */
  capturesAvailable: number;
  /** Null when there is only one capture, so there is nothing to compare. */
  diff: ReturnType<typeof diffAnswers> | null;
  /**
   * Why there is no diff, when there is none. `null` when there is one.
   *
   * A reader told "no change" when the truth is "no comparison" would conclude the
   * brand is stable, and for a queued project the first capture arrives up to 72
   * hours after the question is asked — so this sentence is what stops the moat's
   * own first run from reading as a finding.
   */
  noDiffReason: string | null;
  /** Always present, even when there is no diff. */
  caveat: string;
};

const CAVEAT =
  "This is what changed between two captures, not why. Models change for reasons that are not observable from here — a retraining, a sampling draw, a different query expansion — so a citation that disappeared is an observation and not a verdict on anything you did.";

/**
 * Compare the two most recent captures of one prompt.
 *
 * `afterId` is named by the caller so the comparison is reproducible: "compare
 * these two" is a question with an answer, and defaulting to "the latest two"
 * silently changes the question whenever a capture lands between render and click.
 */
export async function getAnswerDiff(input: {
  projectId: string;
  domain: string;
  prompt: string;
  platform: string;
  afterId?: string;
}): Promise<AnswerDiffResult> {
  const target = await GeoSetupRepository.getTargetByDomain(
    input.projectId,
    input.domain,
  );
  if (!target) {
    throw new AppError(
      "NOT_FOUND",
      `${input.domain} is not a monitored target in this project, so it has no answer history.`,
    );
  }

  const keyword = normaliseKeyword(input.prompt);
  const all = await GeoAnswerRepository.listAnswersForPrompt(
    input.projectId,
    keyword,
    // **Checked here rather than cast.** The handler validates the platform with
    // `z.enum`, so this is unreachable in production — and a cast would make the
    // repository's `GeoPlatform` type a lie for anyone who later calls this
    // directly. `GeoService.requirePlatform` is module-private, and duplicating it
    // would be a second answer to "what is a valid platform", so the check is the
    // one shared predicate: `isGeoPlatform`.
    isGeoPlatform(input.platform) ? input.platform : GEO_PLATFORMS[0],
    50,
  );

  /**
   * Newest first, and **by insertion sort rather than `sort`**, because this
   * project rejects both `.sort()` and the `[...x].sort()` spread while `toSorted`
   * is not on its `lib` target — the same constraint `sovMatrix` and
   * `mentions-trend` already work around by hand.
   *
   * **The comparison is explicit rather than `new Date(...)`**, because the two
   * are stored in different formats and a `Date` would silently produce `NaN` for
   * one of them: `geo_answers.answered_at` is an ISO string and a locale string
   * sorts differently. ISO sorts lexicographically, so a string comparison is both
   * simpler and correct.
   */
  const ordered: typeof all = [];
  for (const row of all) {
    let at = ordered.length;
    for (let i = 0; i < ordered.length; i += 1) {
      const other = ordered[i];
      if (other !== undefined && other.answeredAt < row.answeredAt) {
        at = i;
        break;
      }
    }
    ordered.splice(at, 0, row);
  }

  const afterIndex = input.afterId
    ? ordered.findIndex((row) => row.id === input.afterId)
    : 0;
  const after = afterIndex === -1 ? ordered[0] : ordered[afterIndex];
  const before = afterIndex === -1 ? ordered[1] : ordered[afterIndex + 1];

  const base = {
    prompt: input.prompt,
    capturesAvailable: ordered.length,
    caveat: CAVEAT,
  };

  if (!after || !before) {
    return {
      ...base,
      diff: null,
      noDiffReason:
        ordered.length === 0
          ? "No answer to this question has been archived yet. The nightly patrol is what fills it."
          : "Only one capture of this answer exists, and a comparison needs two. The next run will show what changed.",
    };
  }

  const [beforeCitations, afterCitations] = await Promise.all([
    citationsOf(input.projectId, before.id),
    citationsOf(input.projectId, after.id),
  ]);

  return {
    ...base,
    diff: diffAnswers({
      prompt: input.prompt,
      before: { ...asDiffAnswer(before), citations: beforeCitations },
      after: { ...asDiffAnswer(after), citations: afterCitations },
    }),
    noDiffReason: null,
  };
}

/** One answer's citations, ranked by position as stored. */
async function citationsOf(
  projectId: string,
  answerId: string,
): Promise<DiffCitation[]> {
  const found = await GeoAnswerRepository.getAnswerWithSets(
    projectId,
    answerId,
  );
  /**
   * **`rank` is stored, and a null is not zero.**
   *
   * `geo_answer_citations.rank` is nullable because an annotation without a position
   * is kept and labelled rather than discarded (CL-205) — so a null here means *the
   * vendor never told us where this citation sat*, which is not the same as "it was
   * first". Falling back to the array index would invent a position from insertion
   * order and report a page as having moved when nothing moved.
   *
   * `diffAnswers` treats a null rank as "unpositioned and ranked last", which is the
   * honest reading, so the fallback is `null` rather than a number.
   */
  return (found?.citations ?? []).map((row) => ({
    url: row.url,
    rank: row.rank,
  }));
}
