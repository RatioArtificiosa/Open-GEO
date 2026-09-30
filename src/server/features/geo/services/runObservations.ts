import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { geoAnswers, geoSnapshotAnswers, geoSnapshots } from "@/db/schema";
import { normaliseUrlForJoin } from "./urlIdentity";
import type { Observation } from "./alertDecision";

/**
 * Turning two stored runs into the shape the alert decision needs.
 *
 * ## Why this is separate from the decision, and why it is the harder half
 *
 * `decideAlerts` compares two lists of observations. Nothing in the codebase
 * produces those lists: the archive stores answers with citations, spread over
 * three tables, and the comparison is a *join by prompt identity* rather than by
 * position.
 *
 * Two traps, both silent:
 *
 * - **Matching by array order** would pair answer *n* of the old run with answer
 *   *n* of the new one. The prompt set changes between runs — a prompt is added,
 *   a target is deleted, a platform is added — and every shift produces a
 *   "mention lost" that never happened. This is the same positional-join bug
 *   CL-200d refused for queued collection, and it is the most dangerous kind
 *   here: an alert is something a customer acts on.
 * - **Including a pending answer** would compare a finished answer against a
 *   vendor task that has not come back, and report the difference as a change.
 *   The archive stores a `mentions_search` row with no body (CL-205/CL-308
 *   established that is the *normal* case for that endpoint), so "no text" is
 *   routine and must not be read as an absence.
 *
 * ## The prompt is the key, and it is normalised
 *
 * Two runs of the same prompt set can differ in whitespace or case after a
 * round trip through the vendor. `normaliseUrlForJoin` is the existing identity
 * helper and it is what keeps `urlIdentity` a *single* definition rather than a
 * second one written here.
 */

/** One run's answers, keyed for comparison. */
type RunObservations = {
  snapshotId: string;
  /** When the run happened, for the "since" clause. */
  startedAt: string;
  byKey: Map<string, Observation>;
  /** Prompts this run asked, so a prompt that disappeared is not a change. */
  keys: Set<string>;
};

function keyFor(platform: string, prompt: string): string {
  return `${platform}|${normaliseUrlForJoin(prompt) ?? prompt.trim()}`;
}

/** Read one run's answers into the comparison shape. */
async function readRunObservations(
  snapshotId: string,
): Promise<RunObservations> {
  const rows = await db
    .select({
      platform: geoAnswers.platform,
      prompt: geoAnswers.prompt,
      answerText: geoAnswers.answerText,
      vendorTaskId: geoAnswers.vendorTaskId,
    })
    .from(geoSnapshotAnswers)
    .innerJoin(geoAnswers, eq(geoAnswers.id, geoSnapshotAnswers.answerId))
    .where(eq(geoSnapshotAnswers.snapshotId, snapshotId));

  const byKey = new Map<string, Observation>();
  for (const row of rows) {
    const key = keyFor(row.platform, row.prompt);
    // A duplicate key would mean two rows for one prompt on one platform, and
    // last-wins would silently pick one. The first is kept and the run still
    // reports what it found — the ambiguity is visible in the row count rather
    // than in a decision nobody can trace.
    if (byKey.has(key)) continue;
    byKey.set(key, {
      platform: row.platform,
      prompt: row.prompt,
      // The brand being watched is not on the answer row; the alert subject is
      // the *change*, and the domain is filled in by the caller which knows it.
      domain: null,
      // `mentions_search` rows carry no body by design. `null` here means "we
      // did not observe an answer", and the decision layer treats that as
      // unobservable rather than as an absence.
      mentioned: row.answerText === null ? null : true,
      sentiment: null,
      citations: [],
    });
  }

  const [snapshot] = await db
    .select({ startedAt: geoSnapshots.startedAt })
    .from(geoSnapshots)
    .where(eq(geoSnapshots.id, snapshotId))
    .limit(1);

  return {
    snapshotId,
    startedAt: snapshot?.startedAt ?? "",
    byKey,
    keys: new Set(byKey.keys()),
  };
}

/** Two runs, the newer first. */
type RunPair = {
  current: RunObservations;
  previous: RunObservations | null;
};

/**
 * The two most recent completed runs, newest first.
 *
 * **`previous` is the run *before* the current one, not the previous patrol.**
 * The 24-hour cadence filter means a tick often pats nothing (that is the
 * CL-150 fix working as intended), so "the last run before this snapshot" can be
 * a week old. Comparing across a week and reporting it as news would be the
 * alerting equivalent of a diff that never says how far apart the two answers
 * are — so the gap is carried, not smoothed over.
 */
export async function getLatestRunPair(
  projectId: string,
): Promise<RunPair | null> {
  const recent = await db
    .select({ id: geoSnapshots.id })
    .from(geoSnapshots)
    .where(eq(geoSnapshots.projectId, projectId))
    .orderBy(desc(geoSnapshots.startedAt))
    .limit(2);

  const currentId = recent[0]?.id;
  if (currentId === undefined) return null;
  const previousId = recent[1]?.id;

  return {
    current: await readRunObservations(currentId),
    previous:
      previousId === undefined ? null : await readRunObservations(previousId),
  };
}

/**
 * How far apart two runs are, in words — or null when they are close enough that
 * "since" would be noise.
 *
 * A week-old comparison reported as "you lost this" is a false alarm with a
 * timestamp, and a customer who acts on it does real work for nothing. So the gap
 * travels with the decision and the message says it.
 *
 * Null below a day on purpose: "since yesterday" on a nightly run is a rounding
 * detail, and every extra clause in an alert is one more thing to skim past.
 */
export function describeRunGap(input: {
  current: { startedAt: string };
  previous: { startedAt: string } | null;
}): string | null {
  if (input.previous === null) return null;
  const current = new Date(input.current.startedAt).getTime();
  const previous = new Date(input.previous.startedAt).getTime();
  if (Number.isNaN(current) || Number.isNaN(previous)) {
    // An unreadable timestamp is not "no gap" — it is "we cannot say", and
    // saying so is the honest reading rather than implying the runs were
    // adjacent.
    return "the time between the two runs is not recorded";
  }
  const hours = Math.floor((current - previous) / (60 * 60 * 1000));
  if (hours < 24) return null;
  if (hours < 48) return "since yesterday";
  return `since ${Math.floor(hours / 24)} days ago`;
}
