import { normaliseUrlForJoin } from "./urlIdentity";

/**
 * The answer diff: what changed between two answers to the same question.
 *
 * *"On the 12th, Google's AI Mode for 'best CRMs' cited HubSpot. On the 19th it
 * cited you and dropped HubSpot."*
 *
 * ## Why this is the moat, stated precisely
 *
 * The proposal says it is "only possible with stored history", and that is
 * exactly right — but the interesting part is *why*. Every competitor can ask a
 * model a question right now and show you the answer. **Nobody else can show you
 * the seventh one.** The diff is not a feature built on top of the archive; it is
 * the only output that is *impossible* without it, and it is the answer to the
 * question a customer cannot otherwise answer: "is this working?"
 *
 * ## The identity problem
 *
 * Diffing raw URLs produces noise. The same page arrives with different tracking
 * parameters between runs, and a "new citation" that is the same page under a new
 * `utm_source` is not news — it is the archive disagreeing with itself. So the
 * diff runs on the **normalised** identity from `urlIdentity`, which is the same
 * function the inclusion–citation gap uses. One definition of "the same page", so
 * the two features cannot disagree about it.
 *
 * ## A dropped citation and a new one are the same size, and that is wrong
 *
 * The interesting events are `gained` and `lost`, and they are weighted
 * differently on purpose. A lost citation means a page that was in the answer a
 * week ago is not in it today — that is a *regression someone can act on*. A
 * gained citation may just be a new result the model had not seen. Reporting them
 * as equal would put a regression and an opportunity in the same list, and the
 * reader would not know which to worry about.
 *
 * ## What the diff deliberately does not say
 *
 * It does not say *why* an answer changed. Models change for reasons we cannot
 * observe — a retraining, a sampling draw, a different query expansion. Presenting
 * a citation change as a consequence of anything the customer did last week would
 * be a causal claim with no evidence behind it, and it is the kind of claim that
 * makes a customer attribute a loss to their own content and stop trusting the
 * product.
 */

export type DiffCitation = {
  url: string;
  /** Where in the citation list it sat, 1-based. Null when unknown. */
  rank: number | null;
};

export type DiffAnswer = {
  id: string;
  answeredAt: string;
  citations: DiffCitation[];
};

type CitationChange =
  | { kind: "gained"; url: string; rank: number | null }
  | { kind: "lost"; url: string; rank: number | null }
  | {
      kind: "moved";
      url: string;
      from: number | null;
      to: number | null;
    };

type AnswerDiff = {
  /** The question both answers were to, verbatim. */
  prompt: string;
  before: { id: string; answeredAt: string; citationCount: number };
  after: { id: string; answeredAt: string; citationCount: number };
  changes: CitationChange[];
  /**
   * The one-sentence reading, or null when nothing changed. Null matters: "the
   * answer is stable" is a finding a customer pays for, and an empty list with
   * no sentence is indistinguishable from "we did not run the diff".
   */
  summary: string | null;
  /**
   * Always present. The archive can tell a customer *that* an answer changed and
   * never *why*, and a diff that implies causation it cannot support is worse
   * than no diff.
   */
  caveat: string;
};

/**
 * Sort key for a change: losses first, then gains, then moves.
 *
 * Module-level because it captures nothing, and because a named function that
 * states the ordering as a rule is easier to check than a comparator inlined in
 * an insertion loop.
 */
function changeRank(change: CitationChange): number {
  return change.kind === "lost" ? 0 : change.kind === "gained" ? 1 : 2;
}

/** Stable insertion sort, keeping the caller's array untouched. */
function byChangeOrder(changes: CitationChange[]): CitationChange[] {
  const ordered: CitationChange[] = [];
  for (const change of changes) {
    let at = ordered.length;
    for (let i = 0; i < ordered.length; i += 1) {
      const other = ordered[i];
      if (other !== undefined && changeRank(other) > changeRank(change)) {
        at = i;
        break;
      }
    }
    ordered.splice(at, 0, change);
  }
  return ordered;
}

const CAVEAT =
  "This shows what changed between two stored answers. It does not show why: models change for reasons we cannot observe, so a dropped citation is not evidence that anything you did caused it.";

/**
 * Diff two answers to the same prompt.
 *
 * `before` must be the **earlier** answer. Passing them the other way round
 * inverts every gain into a loss, which reads plausibly and is completely wrong —
 * so the function takes them in date order and asserts it, rather than trusting
 * the caller to have sorted.
 */
export function diffAnswers(input: {
  prompt: string;
  before: DiffAnswer;
  after: DiffAnswer;
}): AnswerDiff {
  if (input.before.answeredAt > input.after.answeredAt) {
    throw new Error(
      `diffAnswers was given the answers in reverse order: "${input.before.answeredAt}" is later than "${input.after.answeredAt}". Sorting them here would hide a caller bug rather than report it.`,
    );
  }

  const beforeByUrl = indexBy(input.before.citations);
  const afterByUrl = indexBy(input.after.citations);

  const changes: CitationChange[] = [];

  for (const [url, afterRank] of afterByUrl) {
    const beforeRank = beforeByUrl.get(url) ?? null;
    if (beforeRank === null) {
      changes.push({ kind: "gained", url, rank: afterRank });
      continue;
    }
    if (beforeRank !== afterRank) {
      changes.push({ kind: "moved", url, from: beforeRank, to: afterRank });
    }
  }
  for (const [url, beforeRank] of beforeByUrl) {
    if (afterByUrl.has(url)) continue;
    changes.push({ kind: "lost", url, rank: beforeRank });
  }

  // Losses first, then gains, then moves. A regression is the thing the customer
  // needs to see before anything else, and a list ordered by URL puts it
  // wherever the alphabet puts it.
  const ordered = byChangeOrder(changes);

  const diff: AnswerDiff = {
    prompt: input.prompt,
    before: {
      id: input.before.id,
      answeredAt: input.before.answeredAt,
      citationCount: input.before.citations.length,
    },
    after: {
      id: input.after.id,
      answeredAt: input.after.answeredAt,
      citationCount: input.after.citations.length,
    },
    changes: ordered,
    summary: null,
    caveat: CAVEAT,
  };
  diff.summary = describe(diff);
  return diff;
}

/** URL → rank, on the normalised identity. A URL with no rank still counts. */
function indexBy(citations: DiffCitation[]): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const [index, citation] of citations.entries()) {
    const key = normaliseUrlForJoin(citation.url);
    // An unusable URL cannot be compared to anything, and treating it as a
    // distinct key would make every run "gain" and "lose" it. Skipping it is the
    // conservative choice: we report fewer changes rather than invented ones.
    if (key === null) continue;
    if (map.has(key)) continue;
    map.set(key, citation.rank ?? index + 1);
  }
  return map;
}

function describe(diff: AnswerDiff): string | null {
  if (diff.changes.length === 0) {
    return `The answer is stable: the same ${diff.after.citationCount} citation${
      diff.after.citationCount === 1 ? "" : "s"
    } in both runs.`;
  }
  const lost = diff.changes.filter((c) => c.kind === "lost");
  const gained = diff.changes.filter((c) => c.kind === "gained");
  const moved = diff.changes.filter((c) => c.kind === "moved");

  const parts: string[] = [];
  if (lost.length > 0) {
    parts.push(
      `${lost.length} citation${lost.length === 1 ? "" : "s"} dropped (${lost
        .slice(0, 3)
        .map((c) => c.url)
        .join(", ")}${lost.length > 3 ? ", …" : ""})`,
    );
  }
  if (gained.length > 0) {
    parts.push(
      `${gained.length} appeared (${gained
        .slice(0, 3)
        .map((c) => c.url)
        .join(", ")}${gained.length > 3 ? ", …" : ""})`,
    );
  }
  if (moved.length > 0) {
    parts.push(`${moved.length} changed position`);
  }
  return `${parts.join("; ")}.`;
}
