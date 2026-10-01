import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  geoAnswerCitations,
  geoAnswers,
  geoSnapshotAnswers,
  geoSnapshots,
} from "@/db/schema";
import { loadDomainsForTargets } from "./observationIdentity";
import { observationKey } from "./observationKey";
import { mentionFromAnswer } from "./mentionFromAnswer";
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

/** Read one run's answers into the comparison shape. */
async function readRunObservations(
  snapshotId: string,
): Promise<RunObservations> {
  const rows = await db
    .select({
      id: geoAnswers.id,
      platform: geoAnswers.platform,
      prompt: geoAnswers.prompt,
      answerText: geoAnswers.answerText,
      source: geoAnswers.source,
      targetId: geoAnswers.targetId,
      projectId: geoAnswers.projectId,
      vendorTaskId: geoAnswers.vendorTaskId,
    })
    .from(geoSnapshotAnswers)
    .innerJoin(geoAnswers, eq(geoAnswers.id, geoSnapshotAnswers.answerId))
    .where(eq(geoSnapshotAnswers.snapshotId, snapshotId));

  // The brand each answer is about, resolved from its own `target_id`.
  //
  // **This is the whole reason mention alerts could never fire.** Every
  // observation carried `domain: null`, and `decideAlerts` refuses any comparison
  // whose domain is null (`alertDecision.ts:204`) because a "mention lost" has to
  // name the brand that lost it. So the decision layer was silently discarding
  // every mention change and only citation changes could ever survive.
  //
  // The earlier comment here claimed "the domain is filled in by the caller which
  // knows it". No caller did. `alertRunner` is handed a `projectId`, and the
  // patrol runs every target in a project as one snapshot, so there is no single
  // domain to pass in — the answer row is the only place that knows.
  //
  // Resolved in one query for the whole run rather than per row. The project is
  // taken from the rows themselves rather than from the caller: an answer is not
  // readable across projects, so reading targets by the *caller's* project would
  // be exactly the cross-project flaw the forecast reader had.
  const projectId = rows[0]?.projectId;
  const domainByTarget =
    projectId === undefined
      ? new Map<string, string>()
      : await loadDomainsForTargets(
          projectId,
          new Set(
            rows
              .map((r) => r.targetId)
              .filter((id): id is string => id !== null),
          ),
        );

  const byKey = new Map<string, Observation>();
  // The pages each answer cited, in one query for the whole run.
  //
  // **This was hardcoded to `[]` for the life of the alerting chain**, which made
  // `decideAlerts`' citation diffing unreachable: it loops over
  // `before.citations`, so an empty list means zero citation changes, ever. The
  // decision layer was complete, correct and tested against hand-built
  // observations — and the reader it was fed by could never produce one. That is
  // the same shape as the `domain: null` defect: a working decision with an
  // unreachable input, and no error anywhere.
  //
  // Citations live in their own table rather than on `geo_answers`, because the
  // composite primary key de-duplicates by URL per answer — re-running a prompt
  // cannot inflate a count, which is what makes every share-of-voice number
  // correct. That de-duplication is preserved here by relying on the table rather
  // than re-deriving a set.
  const citationRows = await db
    .select({
      answerId: geoAnswerCitations.answerId,
      url: geoAnswerCitations.url,
    })
    .from(geoAnswerCitations)
    .innerJoin(geoAnswers, eq(geoAnswers.id, geoAnswerCitations.answerId))
    .innerJoin(
      geoSnapshotAnswers,
      eq(geoSnapshotAnswers.answerId, geoAnswers.id),
    )
    .where(eq(geoSnapshotAnswers.snapshotId, snapshotId));

  const citationsByAnswer = new Map<string, string[]>();
  for (const c of citationRows) {
    const existing = citationsByAnswer.get(c.answerId);
    if (existing) existing.push(c.url);
    else citationsByAnswer.set(c.answerId, [c.url]);
  }

  for (const row of rows) {
    const domain =
      row.targetId === null ? null : (domainByTarget.get(row.targetId) ?? null);
    const key = observationKey({
      domain,
      platform: row.platform,
      prompt: row.prompt,
    });
    // A duplicate key would mean two rows for one prompt on one platform **for the
    // same brand**, and last-wins would silently pick one. The brand is part of
    // the key because two targets in one project are asked the same prompt: keying
    // on prompt alone would discard one brand's answer entirely and report the
    // other's as if it were both.
    //
    // A genuine duplicate within one brand is still dropped, first-wins, and the
    // run still reports what it found — the ambiguity shows up in the row count
    // rather than in a decision nobody can trace.
    if (byKey.has(key)) continue;
    // **The mention judgement is delegated, not re-derived.**
    //
    // The first version read `mentioned` as `row.answerText === null ? null :
    // true`, which is wrong in *both* directions at once:
    //
    // - A `llm_responses` row is an answer to a prompt we asked, stored whether
    //   or not the brand appears in it. Treating its mere existence as a mention
    //   reports 100% visibility forever, which looks like a triumph.
    // - A `mentions_search` row is a hit *because the vendor returned it*, and
    //   carries no body. `answerText === null` therefore marked every Live hit as
    //   **unobservable** — so the one source that is genuinely a mention was the
    //   one source that could never fire an alert.
    //
    // `mentionFromAnswer` is the single rule for this question, it is pure, and it
    // is tested. Two copies of "was the brand named" is how the forecast and the
    // alerting path came to disagree.
    //
    // The brand is passed rather than left blank, so a queued answer can be read
    // for real instead of being refused for want of a domain. Without it every
    // queued answer was permanently unobservable and only Live runs could ever
    // produce an alert.
    const mention = mentionFromAnswer({
      source: row.source,
      answerText: row.answerText,
      domain: domain ?? "",
    });
    byKey.set(key, {
      platform: row.platform,
      prompt: row.prompt,
      domain,
      mentioned: mention.mentioned,
      sentiment: null,
      citations: citationsByAnswer.get(row.id) ?? [],
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
 * The run the caller just finished, and the one before it.
 *
 * **`currentId` is the snapshot the caller names**, not "the newest one in the
 * table". The first version ignored it and re-derived the pair from `projectId`
 * alone, which is wrong whenever two runs can finish out of order: the alert
 * would be decided about a *different* run than the one that had just finished,
 * and the run that actually triggered it would never be compared. The caller
 * knows which run it just did; the question is only what to compare it against.
 *
 * **`previous` is the run *before* that one, not the previous patrol.** The
 * 24-hour cadence filter means a tick often pats nothing (that is the CL-150 fix
 * working as intended), so "the run before this snapshot" can be a week old.
 * Comparing across a week and reporting it as news would be the alerting
 * equivalent of a diff that never says how far apart the two answers are — so
 * the gap is carried, not smoothed over.
 *
 * **Only `complete` runs are eligible for either side.** A `failed` or
 * `running` snapshot archives partial or nothing, so diffing against one
 * manufactures changes out of an outage. The docstring claimed "completed" while
 * the query filtered nothing, so a failed run could become the baseline for every
 * later comparison.
 *
 * **A snapshot covers exactly one brand, not every target in the project.** This
 * paragraph used to assert the opposite, and it was wrong: `runForTarget` writes
 * one snapshot per target, so a three-brand patrol writes three. Brand-level
 * pairing therefore happens here, in the lookup, and not only in the answer key.
 *
 * ## Why the brand is part of the lookup, and not just the answer key
 *
 * A three-brand patrol writes three snapshots that all share a `startedAt` down to
 * the millisecond. The first version asked for "the newest completed run in this
 * project that started before X", and the answer was routinely *a different
 * brand's run*.
 *
 * That is worse than it sounds. A probe against the real schema showed an
 * `acme.com` run pairing with `s1_globex`, and because both sides of the pair
 * carry their own `domain`, the brand-scoped key in `decideAlerts` matched **no
 * rows at all**: the alert reported nothing rather than reporting the wrong brand.
 * Incomplete rather than wrong, but only by accident of the key widening rather
 * than by design.
 *
 * So both queries below filter on `target_id`. A snapshot whose `target_id` is
 * null — every run written before CL-501e — is therefore not eligible to be a
 * baseline, which means existing projects report "no baseline" rather than
 * comparing across brands. **That is a one-time suppression of alerts, and it is
 * the safe direction:** an alert naming the wrong brand is something a customer
 * acts on.
 */
export async function getLatestRunPair(
  projectId: string,
  currentId?: string,
): Promise<RunPair | null> {
  if (currentId === undefined) {
    // No snapshot named — the first-run/no-baseline case. There is nothing to
    // compare and nothing to report, and inventing a "current" from whatever
    // happens to be newest would compare against an unrelated run.
    return null;
  }

  // The caller's run, and **the brand it belongs to**. The brand is read here
  // rather than taken as a parameter because it is a property of the run, not a
  // claim about it: a caller cannot ask for a different brand's comparison, and
  // there is no way to pair two runs of different brands by passing the wrong one.
  const [current] = await db
    .select({
      startedAt: geoSnapshots.startedAt,
      targetId: geoSnapshots.targetId,
    })
    .from(geoSnapshots)
    .where(
      and(
        eq(geoSnapshots.id, currentId),
        eq(geoSnapshots.projectId, projectId),
        eq(geoSnapshots.status, "complete"),
      ),
    )
    .limit(1);
  // Not `complete`, or not in this project — so there is no finished baseline and
  // nothing to compare. This is the branch that stops a `failed` or `running`
  // snapshot from being alerted on, and it is checked here rather than by
  // filtering it out of a list, because "there is no such run" and "the run is not
  // finished" are both `null` and neither is a comparison.
  if (!current) return null;

  // **An unattributed run has no baseline**, and this is a decision rather than an
  // omission.
  //
  // `target_id` is null for every run written before CL-501e. It is tempting to
  // backfill it by joining through the run's answers — `geo_answers.target_id`
  // exists, and that is exactly how the forecast reader resolves a brand. The
  // reasons not to, in order of weight:
  //
  // 1. **A run's answers can name more than one brand.** `GeoPatrol` writes one
  //    snapshot per target, but a run whose answers were deleted leaves no way to
  //    tell which brand it measured. Backfilling such a row would be a brand
  //    attribution nobody had, and it would then become the *baseline* for a real
  //    run — so a fabricated brand could drive a live "you lost this mention"
  //    alert. That is the cross-brand diff wearing a different hat.
  // 2. **The cost is one cycle of silence, not a wrong number.** A project
  //    established before CL-501e alerts again as soon as it has two attributed
  //    runs — one from the next patrol. Nothing is permanently lost, because
  //    history accumulates rather than expires.
  // 3. **A migration cannot express the guard cleanly on both dialects.** "Every
  //    answer agrees on one target" is a correlated subquery whose semantics differ
  //    between SQLite and Postgres, and a backfill that is subtly different per
  //    dialect is worse than none.
  //
  // So the honest state is `null` and a sentence that says so. If a deployment
  // ever needs its history back, the fix is a *deliberate* backfill written
  // against one dialect and verified on both — not a silent one.
  if (current.targetId === null) return null;

  // Then the newest *finished* run **of the same brand** that started strictly
  // before it.
  //
  // **The comparison lives in SQL, not in a JavaScript array.** The previous
  // version loaded every snapshot the project had ever written and then picked
  // the neighbouring element, which was correct and unbounded: a project patrolled
  // daily for two years has ~700 snapshots per brand, and the whole table was
  // read to choose one row. Worse, the in-memory version silently depended on
  // `currentId` being present in that list, so `LIMIT 2` — the obvious way to bound
  // it — reintroduced the bug this was fixed for: when the caller's run was not
  // among the newest two, the pair became "some other run vs the newest". A
  // `WHERE started_at < ?` is both bounded and exactly the intended question, and
  // no bound can make it wrong.
  const [previous] = await db
    .select({ id: geoSnapshots.id })
    .from(geoSnapshots)
    .where(
      and(
        eq(geoSnapshots.projectId, projectId),
        eq(geoSnapshots.status, "complete"),
        eq(geoSnapshots.targetId, current.targetId),
        lt(geoSnapshots.startedAt, current.startedAt),
      ),
    )
    .orderBy(desc(geoSnapshots.startedAt))
    .limit(1);

  return {
    current: await readRunObservations(currentId),
    previous:
      previous === undefined ? null : await readRunObservations(previous.id),
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
