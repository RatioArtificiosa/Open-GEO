import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { geoAnswers, geoSnapshotAnswers, geoSnapshots } from "@/db/schema";
import { GeoSetupRepository } from "@/server/features/geo/repositories/GeoSetupRepository";
import { normaliseDomain } from "@/server/features/geo/domain";
import { AppError } from "@/server/lib/errors";
import { mentionFromAnswer } from "./mentionFromAnswer";
import {
  forecastVisibility,
  type VisibilityObservation,
} from "./visibilityForecast";

/**
 * Reading the forecast's inputs out of the runs we actually measured.
 *
 * ## What changed when the denominator arrived
 *
 * The first version of this file read `ai_mention_history` and refused, because
 * that table has a numerator and no denominator. It refused for the right reason
 * and was still pointed at the **wrong measurement**: `llm_mentions/historical`
 * reports the *vendor's* monthly estimate of how often a brand is mentioned
 * across the vendor's own prompt set, which is a different question from "of the
 * questions we asked, how many named us".
 *
 * So this reads runs and answers instead — our own questions, our own archive.
 *
 * ## Two facts this has to establish, and one of them is new
 *
 * **The denominator is `geo_snapshots.prompts_asked`**, recorded by CL-501c, and
 * it is null for every run acquired through the Live path because the vendor
 * never discloses how many prompts it asked. Only queued runs carry one.
 *
 * **The numerator is the hard part, and it is a text question.** A
 * `mentions_search` row *is* a hit — the vendor only returns prompts that named
 * the brand — so its presence is the answer. A `llm_responses` row is not: it is
 * the answer to a prompt we asked, stored **whether or not the brand appears in
 * it**. Counting every queued answer as a mention would report 100% visibility
 * for every project, permanently, and it would look like a triumph.
 *
 * So the brand has to be found in the text. That is a judgement, not a
 * measurement, and `mentionFromAnswer` below is where the honesty lives: for an
 * answer it cannot read, it returns **null**, and null is counted as neither a
 * mention nor an absence.
 *
 * The existing alerting path (`runObservations.ts`) assumes
 * `answerText !== null` means mentioned, which is correct for `mentions_search`
 * and **wrong for `llm_responses`**. That file is only ever fed Live runs
 * today, so the defect is latent rather than live, and it is recorded here
 * because this reader is the first to mix the two.
 */

/** One run's worth of forecast input. */
type RunObservation = VisibilityObservation & {
  snapshotId: string;
  /** The run's start, ISO, carried so a caller can label the point. */
  startedAt: string;
};

export type ForecastInput = {
  domain: string;
  platform: string;
  /** Oldest first. A run missing either half of its rate is absent. */
  observations: RunObservation[];
  /**
   * Runs that existed but produced no observation, and why. A count is not a
   * story: "we skipped 4 of 9 runs" says something a bare list of 5 does not.
   */
  skipped: { unknownDenominator: number; noText: number; noAnswers: number };
  /**
   * How many runs were *considered*, and how many the window allowed.
   *
   * `considered` is what `note` counts against, and it is bounded by the look-back
   * window. Without `windowed` a caller reading "Forecasted from 1 of 2 runs"
   * cannot tell whether the project has two runs or two hundred and twenty-four —
   * and the second reading is the misleading one, because it implies the
   * history is exhausted when it was merely cropped.
   *
   * `totalRunsInProject` settles it: when it exceeds `considered`, the note is
   * describing a window rather than the whole archive, and it says so.
   */
  windowed: {
    considered: number;
    /** Null when the window covered every run this project has. */
    totalRunsInProject: number | null;
  };
  /** Null when there is nothing to say, rather than a sentence every time. */
  note: string | null;
};

/**
 * How many runs the forecast looks back over when no limit is given.
 *
 * 24 is about six months of weekly runs. It is a *reading* bound rather than a
 * correctness one — the forecast buckets by week and a direction needs 16 of
 * them — so it is generous enough that the refusal below, not the limit, is what
 * tells a reader the history is too short.
 */
const DEFAULT_RUN_LIMIT = 24;

/**
 * Why there is nothing to forecast.
 *
 * **Both acquisition paths are currently silent, not just the Live one.** The
 * original wording blamed only the live path, because at the time that was the
 * only one understood to lack a denominator. Tracing the queued path showed
 * otherwise:
 *
 * - `GeoPatrol` computes `promptsAsked: posted` for the queued branch and
 *   returns it — but returns `snapshotId: null`, because a queued run posts
 *   prompts and archives nothing. Nothing persists the count.
 * - `queueDrainRunner` later calls `settleCollectedTask` **without** a
 *   `snapshotId`, so the answers land in `geo_answers` attached to no snapshot
 *   at all, and no `prompts_asked` is ever written.
 *
 * So today *no* run carries a denominator and the forecast is permanently
 * refused. Naming only the live path would send an operator to fix the wrong
 * path: the live path **cannot** be fixed (the vendor does not disclose its
 * prompt-set size), while the queued path **can**, and is the one worth doing.
 *
 * That ordering matters. A reader who is told "this is what the vendor will not
 * tell us" concludes there is nothing to do; a reader told the queued path is
 * ours to fix learns that the number is reachable.
 */
const NOTE_NO_RUNS =
  "No run has recorded how many prompts it asked, so there is nothing to " +
  "forecast yet. This is not only a vendor limitation: a run collected through " +
  "the live path cannot know its own denominator, because the vendor picks the " +
  "prompts and never discloses how many. Queued runs ask our own explicit " +
  "prompts and so do have a denominator — but nothing records it yet, which is " +
  "ours to fix rather than theirs.";

const NOTE_PARTIAL = (usable: number, total: number, cropped?: number) =>
  `Forecasted from ${usable} of ${total} runs` +
  (cropped === undefined
    ? "."
    : `, and ${cropped} older run${cropped === 1 ? "" : "s"} were not read.`) +
  " The rest are not shown because they either did not record how many prompts " +
  "they asked, or their answers have not come back yet — and a run we cannot " +
  "measure is not a run that found nothing.";

/**
 * The forecast's observations, oldest first, from the runs we can measure.
 *
 * A run is used only when **both** halves of its rate are known: the prompts
 * asked (`prompts_asked`, CL-501c) and the answers that named the brand. A run
 * missing either is counted in `skipped` and contributes nothing, because a
 * proportion with one side missing is not a small proportion — it is not a
 * proportion.
 */
export async function readForecastInput(input: {
  projectId: string;
  domain: string;
  platform: string;
  limit?: number;
}): Promise<ForecastInput> {
  const domain = normaliseDomain(input.domain);
  const target = await GeoSetupRepository.getTargetByDomain(
    input.projectId,
    domain,
  );
  if (!target) {
    throw new AppError(
      "NOT_FOUND",
      `${input.domain} is not a monitored target in this project, so it has no visibility history.`,
    );
  }

  // The other names the brand is known by, read once for the whole page.
  //
  // `aliases` is stored as a single comma-separated string — `GeoService.upsertTarget`
  // joins the array with ", " — so it is split here rather than in the rule, which
  // keeps the rule a pure function of its arguments and keeps the storage format
  // out of the domain logic. `name` is included because a target added as
  // `name: "Acme Corp"` says so explicitly, and ignoring it would be odd.
  const targetNames = [
    target.name,
    ...(target.aliases ?? "").split(",").map((a) => a.trim()),
  ].filter((n) => n.length > 0);

  // The scoping query, and the reason it is not simply "every run in the project".
  //
  // **`geo_snapshots` has no `target_id`** — only `project_id` and `prompt_set_id`.
  // A project can monitor several brands, so filtering on `projectId` alone returns
  // every run the customer has ever made and then labels all of them with the
  // domain that was *asked for*. One brand's visibility would be reported under
  // another's name, which is worse than showing nothing: it looks like a
  // measurement, it is a different company's data, and nothing in the payload says
  // so. The first version of this file did exactly that.
  //
  // **`geo_answers` does carry `target_id`**, so the target is resolved by joining
  // snapshots through their answers. One query rather than one-per-run also
  // removes the N+1 the loop below used to make.
  //
  // A run whose answers were all deleted has no way to name its target, so it is
  // excluded here and reported as `noAnswers` — counted separately rather than
  // silently folded into another brand's history.
  //
  // `limit` bounds **runs, not rows**, and it has to be applied here rather than
  // to `answerRows`: a row-level cap would cut a run's answers off mid-run, and
  // the run would then look like one that found nothing — a rate computed on a
  // fraction of the prompts asked, in the flattering direction again. So the
  // newest N runs are chosen first, in a subquery, and every answer of those runs
  // comes back.
  //
  // **LEFT joins, deliberately.** The first version inner-joined, which made a run
  // that archived nothing invisible: it matched no answers, so it appeared in no
  // bucket, so `skipped` never counted it and the "runs not included" figure
  // quietly omitted it. A run that asked 40 prompts and archived none is exactly
  // what a reader needs told — it is the difference between "we looked and found
  // nothing" and "we cannot say", and hiding it makes the two identical.
  //
  // The cost is that a run belonging to *another* brand also matches. That is
  // handled where it is counted rather than here: `noAnswers` absorbs any run with
  // no answers of *this* brand on *this* platform, whether it archived nothing at
  // all or archived only another brand's.
  const recentRuns = db
    .select({ id: geoSnapshots.id })
    .from(geoSnapshots)
    .leftJoin(
      geoSnapshotAnswers,
      eq(geoSnapshotAnswers.snapshotId, geoSnapshots.id),
    )
    .leftJoin(geoAnswers, eq(geoAnswers.id, geoSnapshotAnswers.answerId))
    .where(
      and(
        eq(geoSnapshots.projectId, input.projectId),
        // Either no answers at all, or at least one for this brand. A run holding
        // only another brand's answers is deliberately excluded: it is not this
        // brand's run and counting it would understate the forecast's coverage.
        or(isNull(geoAnswers.id), eq(geoAnswers.targetId, target.id)),
      ),
    )
    .orderBy(desc(geoSnapshots.startedAt))
    .limit(input.limit ?? DEFAULT_RUN_LIMIT);

  const answerRows = await db
    .select({
      // **The snapshot's own id, not the join table's.** `geo_snapshot_answers
      // .snapshot_id` is null for a run that archived nothing, so selecting it
      // from there made the answerless row unusable and dropped it — which is why
      // the first attempt at this fix left `noAnswers` at zero even with the
      // left joins in place. The id that identifies the run is on the snapshot.
      snapshotId: geoSnapshots.id,
      startedAt: geoSnapshots.startedAt,
      promptsAsked: geoSnapshots.promptsAsked,
      source: geoAnswers.source,
      answerText: geoAnswers.answerText,
      platform: geoAnswers.platform,
    })
    .from(geoSnapshots)
    .leftJoin(
      geoSnapshotAnswers,
      eq(geoSnapshotAnswers.snapshotId, geoSnapshots.id),
    )
    .leftJoin(geoAnswers, eq(geoAnswers.id, geoSnapshotAnswers.answerId))
    .where(
      and(
        eq(geoSnapshots.projectId, input.projectId),
        // **The brand filter is in the subquery, not here.** This query is left
        // unfiltered on target so that a run with no answers at all still returns
        // one row — with every answer column null — and therefore still reaches
        // `byRun` and is counted as `noAnswers`. Filtering by target here made
        // the row disappear, which is the defect the subquery change was meant to
        // fix; the count was silently still zero.
        inArray(geoSnapshots.id, recentRuns),
      ),
    )
    .orderBy(desc(geoSnapshots.startedAt));

  const skipped = { unknownDenominator: 0, noText: 0, noAnswers: 0 };
  const observations: RunObservation[] = [];
  // Newest first from the query, so the *last* row of a run is that run's latest.
  const byRun = new Map<string, (typeof answerRows)[number][]>();
  const runMeta = new Map<
    string,
    { startedAt: string; promptsAsked: number | null }
  >();

  for (const row of answerRows) {
    // `snapshotId` is now `geo_snapshots.id`, which is non-null on every row. The
    // *answer* columns are null when the run archived nothing, and that is exactly
    // the shape this loop has to preserve rather than filter out.
    const id = row.snapshotId;
    const bucket = byRun.get(id);
    if (bucket) bucket.push(row);
    else byRun.set(id, [row]);

    const meta = runMeta.get(id);
    if (meta) meta.startedAt = row.startedAt;
    else
      runMeta.set(id, {
        startedAt: row.startedAt,
        promptsAsked: row.promptsAsked,
      });
  }

  for (const [snapshotId, answers] of byRun) {
    const meta = runMeta.get(snapshotId);
    // The denominator first: a run that cannot say how many prompts it asked
    // cannot produce a rate whatever its answers contain.
    //
    // Zero is counted here rather than producing a 0% observation. "Asked
    // nothing" is not "named in none of them", and a 0% point on a chart is a
    // claim about visibility that the run never made.
    if (
      meta?.promptsAsked === null ||
      meta?.promptsAsked === undefined ||
      meta.promptsAsked === 0
    ) {
      skipped.unknownDenominator += 1;
      continue;
    }

    // Per platform, always. Two platforms compute visibility differently, and a
    // run that measured both cannot be reported as one number.
    //
    // A run that archived nothing arrives here as a single row with null answer
    // columns, and `a.platform` is null — so it falls out here and is counted as
    // `noAnswers`. That is the intended path, not an accident of the join.
    const onPlatform = answers.filter((a) => a.platform === input.platform);
    if (onPlatform.length === 0) {
      skipped.noAnswers += 1;
      continue;
    }

    // Narrowed to rows that actually have an answer, so the spread below cannot
    // hand `mentionFromAnswer` a null source.
    //
    // **The target's own names are passed as needles.** `geo_targets` has carried
    // `name` and `aliases` since the table was created — its comment says "Brands
    // are often wider than a domain" — and neither was ever read by any consumer.
    // So a customer who told us the brand is called "Acme" got a lower visibility
    // number than one who left the field empty, which is backwards.
    const evidence = onPlatform.map((a) =>
      mentionFromAnswer({
        source: a.source ?? "llm_responses",
        answerText: a.answerText,
        domain,
        aliases: targetNames,
      }),
    );
    // One unreadable answer makes the numerator unknown. Dropping just that
    // answer would quietly shrink the sample while the denominator stayed put,
    // reporting the run's rate on fewer prompts than were asked — the flattering
    // direction again.
    if (evidence.some((e) => e.mentioned === null)) {
      skipped.noText += 1;
      continue;
    }

    observations.push({
      snapshotId,
      startedAt: meta.startedAt,
      platform: input.platform,
      // The run's date, not the answers'. A run is the unit of measurement and
      // the forecast buckets by week; per-answer timestamps would scatter one
      // run's answers across buckets and read as several observations.
      date: meta.startedAt.slice(0, 10),
      promptsAsked: meta.promptsAsked,
      mentions: evidence.filter((e) => e.mentioned === true).length,
    });
  }

  // The query is newest first; the forecast's slope reads oldest first.
  observations.reverse();

  // How many runs were considered — bounded by the look-back window, which is why
  // `windowed` below reports the project's real total alongside it.
  const total = byRun.size;

  // How many runs this project has for this brand at all, so a cropped window can
  // say so rather than implying the history ended.
  //
  // Only needed when the window actually bit, so it is skipped otherwise — this
  // is a dashboard read and an extra count on every load would be a cost paid for
  // nothing in the overwhelmingly common case of a young project.
  const limit = input.limit ?? DEFAULT_RUN_LIMIT;
  let totalRunsInProject: number | null = null;
  if (total >= limit) {
    const counted = await db
      .select({ id: geoSnapshots.id })
      .from(geoSnapshots)
      .leftJoin(
        geoSnapshotAnswers,
        eq(geoSnapshotAnswers.snapshotId, geoSnapshots.id),
      )
      .leftJoin(geoAnswers, eq(geoAnswers.id, geoSnapshotAnswers.answerId))
      .where(
        and(
          eq(geoSnapshots.projectId, input.projectId),
          or(isNull(geoAnswers.id), eq(geoAnswers.targetId, target.id)),
        ),
      );
    totalRunsInProject = new Set(counted.map((r) => r.id)).size;
  }
  const cropped =
    totalRunsInProject === null
      ? undefined
      : Math.max(0, totalRunsInProject - total);

  const note =
    observations.length === 0
      ? NOTE_NO_RUNS
      : // Cropping is reported on **every** branch where it happened, not only when
        // some run was skipped. The first version mentioned it only alongside
        // `NOTE_PARTIAL`, so a window in which every read run happened to be usable
        // said nothing at all — which is the case where a reader is most likely to
        // believe the window *is* the history.
        cropped === undefined
        ? observations.length < total
          ? NOTE_PARTIAL(observations.length, total)
          : null
        : observations.length < total
          ? NOTE_PARTIAL(observations.length, total, cropped)
          : `Forecasted from all ${total} runs read here, and ${cropped} older ` +
            `run${cropped === 1 ? " was" : "s were"} outside the look-back window.`;

  return {
    domain: target.domain,
    platform: input.platform,
    observations,
    skipped,
    windowed: { considered: total, totalRunsInProject },
    note,
  };
}

/**
 * The forecast for a stored series, or the reason there is not one.
 *
 * The refusal travels **with** the series rather than as an exception, because
 * "we have nine runs and none of them says how many prompts it asked" is a
 * useful thing for a dashboard to say, and a throw would leave the panel blank
 * with no explanation.
 *
 * ## Why `note` is not also lifted to the top level
 *
 * The first version returned `{ series, forecast, note }` where `note` was
 * `series.note` — the same string in two places in one payload. A caller reading
 * `data.note` and a caller reading `data.series.note` would both be correct and
 * the two would have to be kept in step, and the first edit that forgot to would
 * ship a panel contradicting itself. So it stays on the series, next to the
 * `skipped` counts it is derived from, and there is exactly one of it.
 */
export async function forecastForStoredSeries(input: {
  projectId: string;
  domain: string;
  platform: string;
}) {
  const series = await readForecastInput(input);
  const forecast = forecastVisibility(series.observations);
  return { series, forecast };
}
