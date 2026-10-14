import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { db } from "@/db";
import { geoAnswers, geoTargets, projects } from "@/db/schema";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { GeoAnswerRepository } from "@/server/features/geo/repositories/GeoAnswerRepository";
import { readForecastInput } from "@/server/features/geo/services/visibilityForecastReads";
import { forecastVisibility } from "@/server/features/geo/services/visibilityForecast";
import {
  PACE_HORIZON_DAYS,
  projectVisibilityPace,
} from "@/server/features/geo/services/visibilityPace";
import { citationWinProbability } from "@/server/features/geo/services/citationWinProbability";
import {
  citationWinSnapshot,
  visibilityForecastSnapshot,
  visibilityPaceSnapshot,
  type ForecastSnapshotRow,
} from "@/server/features/geo/services/forecastSnapshot";
import { ForecastSnapshotsRepository } from "@/server/features/geo/repositories/ForecastSnapshotsRepository";
import { RETRIEVAL_PLATFORMS } from "@/server/features/geo/repositories/GeoSetupRepository";

/**
 * CL-503's nightly forecast job — the writer every forecast in this product never had.
 *
 * ## Why this exists at all
 *
 * `categoryMomentum`, `breakoutSignals`, `projectVisibilityPace` and
 * `citationWinProbability` are four honest modules that were all **computed inside a
 * request handler and discarded**. They are pure, they are tested, and none of them
 * left a trace: so the product could say "at this pace you reach 30% of prompts in
 * ten weeks" and could never, ten weeks later, say whether it did. A forecast nobody
 * kept cannot be scored, and an unscorable forecast is decoration.
 *
 * This sweep writes one **dated** row per (project, kind, subject, day) into
 * `geo_forecast_snapshots`, and `forecastAccuracy.ts` reads them back against what
 * was measured. Together those two halves are the feature.
 *
 * ## Why it costs nothing, and why B1/B2 are not here
 *
 * **Every input is already stored** — `geo_answers`, `geo_answer_citations`,
 * `geo_answer_retrievals`, `geoTargets` and the newest audit. There is no vendor call
 * in this file, so there is no budget to enforce, no credit gate, and no way for it
 * to overspend. That is the whole reason the *free* forecasts are the ones scheduled
 * nightly: the two that need a live `google_trends/explore` (B1 category momentum,
 * B2 breakout signals) would put a billable capture behind a cron with no budget,
 * which is the exact shape `nightlyCaptures.ts` was written to stop. Their price and
 * shape are recorded as a founder decision in `specs/0021-nightly-forecast-job.md`,
 * and this file is deliberately not the place they get started quietly.
 *
 * ## Why it is not inside `nightlyCaptures.ts`
 *
 * That module's contract is *"the nightly captures that bill the vendor"*, and its
 * ordering rule is cheap-work-first-billable-last. Putting a free job inside it would
 * break both claims: a reader looking there for cost would find a job that has none,
 * and the ordering — which exists so a vendor outage cannot block the archive —
 * would be applied to work no outage can stop. The forecasts also read the archive
 * the patrol just filled, so they run **after** the billable captures on the same
 * nightly tick, which is the one ordering that matters.
 *
 * ## Why every collaborator is injected
 *
 * All five of them reach the database, and the house rule for a scheduled sweep is
 * that a test drives it through its collaborators. The alternative — a suite that
 * seeds SQLite — is a stronger test and this repo has one, but it cannot reach the
 * branch where the *vendor-shaped* input is wrong: a denominator of null, a readiness
 * state of "unknown", a platform that returns no retrievals. Those are the states
 * this job spends most of a young archive's life in, and each of them is a separate
 * line of code that either stores a refusal or invents a number.
 */

/**
 * The trailing window the citation base rate is measured over.
 *
 * The same band `visibilityPace` speaks over, stated here as a literal rather than
 * imported, because the two numbers answer different questions that happen to share
 * a size: one is a projection horizon, the other is a measurement window. Making one
 * a constant of the other would imply a relationship neither engine claims.
 */
const CITATION_WINDOW_DAYS = 90;

/** One (project, target) pair with the platforms that have measured answers for it. */
type ForecastTarget = {
  projectId: string;
  targetId: string;
  domain: string;
  /** Distinct platforms with an answer for this target. */
  platforms: string[];
};

/**
 * The night's shape.
 *
 * **Not exported**: nothing outside this file names it, and `server.ts` reads the
 * fields off the returned value. An exported type nothing imports is a claim about
 * an API surface that is not true.
 *
 * Each count is separate and none is a total, for the reason
 * `scheduledOpportunityInputs` gives: *a silent sum is what let the missing purge go
 * unnoticed*. "3 pace rows" and "1 pace row and 2 citation rows" are different
 * nights, and one number cannot say which happened.
 */
type ForecastNightReport = {
  projectsVisited: number;
  targetsVisited: number;
  /** `visibility_forecast` rows written — the anchors. */
  anchorsStored: number;
  /** `visibility_pace` rows written — the projections that get scored. */
  pacesStored: number;
  /** `citation_win` rows written. */
  citationWinsStored: number;
  /**
   * Rows whose engine declined to give a number.
   *
   * Reported as its own count rather than folded into the stored counts, because a
   * decline is a measurement the product shows: it is the difference between "we
   * cannot forecast this yet" and "the job did not run", and a reader has to be able
   * to see which one tonight was.
   */
  declined: number;
  /**
   * Targets dropped by the sweep limit.
   *
   * Named rather than silently dropped, for the reason `scheduledEtvCapture` names
   * its own: a sweep that stops measuring a project reads as a project that measured
   * nothing, and the first deploy is where that happens.
   */
  skippedForLimit: number;
  errors: string[];
};

/** `YYYY-MM-DD` in UTC. The date, not the timestamp — a forecast is dated to the day. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The ISO instant `days` before `date`, for the citation window's `since`. */
function daysBefore(date: Date, days: number): string {
  return new Date(date.getTime() - days * 86_400_000).toISOString();
}

/**
 * Every (project, target) with at least one measured answer, with its platforms.
 *
 * ## Why the read starts from `geo_answers` and not from `geo_targets`
 *
 * `geo_targets` says what a customer *wants* measured; `geo_answers` says what was
 * actually measured, and it is the only table carrying **both** `target_id` and
 * `platform`. Starting from targets would produce a pair for every brand a customer
 * ever added — including ones whose runs all failed, or that were added after the
 * last patrol — and each of those would write a row of nulls. That is not harmless:
 * a row of nulls is indistinguishable from a decline, and a product that reports "we
 * cannot forecast this" for a target nobody ever asked about is a product that
 * teaches its reader to ignore it.
 *
 * `target_id` is nullable (every answer written before the column existed), and
 * those rows are excluded rather than attributed to a guess. A run that cannot name
 * its brand is a run this job cannot forecast, and `readForecastInput`'s own scoping
 * makes the same choice for the same reason.
 *
 * ## Why it is one query and not one per project
 *
 * The pair is a join across three tables with no per-project work in it, so there is
 * nothing to gain from a loop and an N+1 to lose — and this is the one job that runs
 * across every customer nightly.
 *
 * ## Why archived projects are excluded
 *
 * Archiving is a deletion promise. A forecast written for an archived project is a
 * forecast for something the customer has asked us to stop measuring, and the
 * snapshot would sit in a table nobody reads. The retention sweep makes the same
 * choice for the same reason.
 */
async function readForecastTargets(): Promise<ForecastTarget[]> {
  const rows = await db
    .selectDistinct({
      projectId: geoAnswers.projectId,
      targetId: geoAnswers.targetId,
      domain: geoTargets.domain,
      platform: geoAnswers.platform,
    })
    .from(geoAnswers)
    .innerJoin(geoTargets, eq(geoTargets.id, geoAnswers.targetId))
    .innerJoin(projects, eq(projects.id, geoAnswers.projectId))
    .where(and(isNotNull(geoAnswers.targetId), isNull(projects.archivedAt)));

  const byTarget = new Map<string, ForecastTarget>();
  for (const row of rows) {
    const key = `${row.projectId}|${row.targetId ?? ""}`;
    const existing = byTarget.get(key);
    if (existing) {
      if (!existing.platforms.includes(row.platform)) {
        existing.platforms.push(row.platform);
      }
      continue;
    }
    byTarget.set(key, {
      projectId: row.projectId,
      targetId: row.targetId ?? "",
      domain: row.domain,
      platforms: [row.platform],
    });
  }

  return [...byTarget.values()];
}

/**
 * Counts widened into per-retrieval observations.
 *
 * A restatement of two counters, deliberately: `citationWinProbability` reads
 * *observations*, not totals, and widening them here keeps the probability module
 * pure and keeps the counting in one place. The alternative — a second code path
 * computing a rate from counts — would be a second implementation of a Wilson
 * interval, which is how two surfaces end up quoting different numbers for the same
 * night.
 */
function observationsOf(
  count: number,
  cited: boolean,
): Array<{ cited: boolean }> {
  return Array.from({ length: Math.max(0, count) }, () => ({ cited }));
}

/** What one target wrote, kept separate so the sweep cannot sum it into a total. */
type TargetWrite = {
  anchors: number;
  paces: number;
  citationWins: number;
  declined: number;
};

/**
 * The forecasts for one project's one target.
 *
 * Isolated per target rather than per project: a project watching three brands gets
 * three independent attempts, and one brand's failure is not the others' — which
 * matters more here than in the billable captures, because a failure here is a
 * missing *evidence row* rather than a missing vendor answer, and the archive
 * already holds the data to retry with.
 */
async function captureTarget(input: {
  target: ForecastTarget;
  issuedOn: string;
  /** Readiness for the whole project, resolved once by the sweep. */
  retrievalsComplete: boolean | null;
  readForecast: typeof readForecastInput;
  countCitations: typeof GeoAnswerRepository.countRetrievalsAndCitations;
  storeSnapshot: typeof ForecastSnapshotsRepository.insertSnapshot;
}): Promise<TargetWrite> {
  const { target, issuedOn, retrievalsComplete } = input;
  const written: TargetWrite = {
    anchors: 0,
    paces: 0,
    citationWins: 0,
    declined: 0,
  };

  for (const platform of target.platforms) {
    const series = await input.readForecast({
      projectId: target.projectId,
      domain: target.domain,
      platform,
    });
    const forecast = forecastVisibility(series.observations);
    const reading = forecast.current.find((row) => row.platform === platform);
    const direction = forecast.direction;

    // **The anchor row.** The reading as it stands tonight: the share, its interval,
    // the denominator it rests on, and the note saying which runs it was allowed to
    // read. Horizon 0, because it claims nothing about the future — see
    // `visibilityForecastSnapshot`.
    const anchor = visibilityForecastSnapshot({
      projectId: target.projectId,
      issuedOn,
      domain: target.domain,
      subject: platform,
      share: reading?.rate ?? null,
      low: reading?.low ?? null,
      high: reading?.high ?? null,
      perWeek: direction.perWeek,
      now: reading?.rate ?? null,
      basedOn: reading?.basedOn ?? 0,
      basedOnWeeks: direction.basedOnWeeks,
      confidence: reading?.confidence ?? null,
      note: series.note,
    });
    await input.storeSnapshot(anchor);
    written.anchors += 1;
    if (anchor.shareBp === null) written.declined += 1;

    // **The pace row.** The projection: what the measured pace implies after the
    // band. Computed by `projectVisibilityPace` rather than re-deriving the
    // extension here, so the stored row and the sentence a reader sees on the page
    // come from one function.
    const pace = projectVisibilityPace({
      platform,
      rateNow: reading?.rate ?? null,
      perWeek: direction.perWeek,
      basedOnWeeks: direction.basedOnWeeks,
      horizonDays: PACE_HORIZON_DAYS,
    });
    const paceSnapshot = visibilityPaceSnapshot({
      projectId: target.projectId,
      issuedOn,
      domain: target.domain,
      subject: platform,
      share: pace.shareAfterHorizon,
      low: null,
      high: null,
      perWeek: pace.perWeek,
      now: pace.rateNow,
      basedOn: reading?.basedOn ?? 0,
      basedOnWeeks: direction.basedOnWeeks,
      confidence: reading?.confidence ?? null,
      note: series.note,
      horizonDays: PACE_HORIZON_DAYS,
    });
    await input.storeSnapshot(paceSnapshot);
    written.paces += 1;
    if (paceSnapshot.shareBp === null) written.declined += 1;
  }

  // **The citation win rate, across the platforms that return retrievals.**
  //
  // Only `RETRIEVAL_PLATFORMS` count: DataForSEO returns citations without the
  // retrieved-page list on the others, so a platform outside that set can only ever
  // contribute zero to both halves — and zero citations out of zero retrievals reads
  // as "never cited" when the truth is "never looked at".
  //
  // Summed across platforms rather than kept apart, and the window is stated in the
  // row: a retrieval is a retrieval, and a 90-day base rate split by platform is
  // four samples each too small for the floor, where one of them is not.
  let retrievals = 0;
  let citations = 0;
  for (const platform of RETRIEVAL_PLATFORMS) {
    if (!target.platforms.includes(platform)) continue;
    const counts = await input.countCitations(
      target.projectId,
      target.targetId,
      platform,
      target.domain,
      {
        since: daysBefore(
          new Date(`${issuedOn}T00:00:00Z`),
          CITATION_WINDOW_DAYS,
        ),
      },
    );
    retrievals += counts.retrievals;
    citations += counts.citations;
  }

  if (retrievals > 0 || citations > 0) {
    const probability = citationWinProbability({
      retrievals: [
        ...observationsOf(retrievals - citations, false),
        ...observationsOf(citations, true),
      ],
      retrievalsComplete,
    });
    const win = citationWinSnapshot({
      projectId: target.projectId,
      issuedOn,
      domain: target.domain,
      subject: target.domain,
      share: probability.probability,
      low: probability.low,
      high: probability.high,
      perWeek: null,
      now: probability.baseRate,
      basedOn: probability.retrievalsObserved,
      basedOnWeeks: null,
      confidence: null,
      note:
        `${citations} cited of ${retrievals} retrieved over ${CITATION_WINDOW_DAYS} days` +
        `; readiness ${retrievalsComplete === null ? "unknown" : retrievalsComplete ? "complete" : "outstanding"}`,
      horizonDays: CITATION_WINDOW_DAYS,
    });
    await input.storeSnapshot(win);
    written.citationWins += 1;
    if (win.shareBp === null) written.declined += 1;
  }

  return written;
}

/**
 * Sweep every project with a measured target, and store tonight's forecasts.
 *
 * ## Why there is no budget and no clock filter
 *
 * There is no budget because there is nothing to spend: this is the only nightly
 * capture that makes no vendor call. There is no `lastAskedAt` rotation because
 * `server.ts` gates the call on the nightly tick, and the unique key makes a second
 * run on the same night a no-op rather than a fork. **Both absences are deliberate
 * and are the reason this file is short**: a budget checked over zero spend is a
 * comment pretending to be a control.
 *
 * `limitProjects` stays, for the reason it exists on every other sweep: a first
 * deploy must not fan out across every tenant in one tick.
 */
export async function runDueForecastSnapshots(input?: {
  limitProjects?: number;
  now?: Date;
  /** Injected so a test can drive the sweep without a database. */
  fetchTargets?: typeof readForecastTargets;
  /** Injected for the same reason; readiness is one read per project, not per target. */
  fetchReadiness?: typeof AuditService.latestReadinessState;
  /** Injected for the same reason. */
  readForecast?: typeof readForecastInput;
  /** Injected for the same reason. */
  countCitations?: typeof GeoAnswerRepository.countRetrievalsAndCitations;
  /**
   * Injected for the same reason.
   *
   * **Named `storeSnapshot` and not `writeSnapshot` on purpose.** The GEO
   * module-reachability gate reads a trailing-comma shorthand member as a
   * repository *writer declaration*, so a parameter called `writeSnapshot` passed
   * that way was reported as an orphaned writer — a false positive that would have
   * been "fixed" by weakening the gate. The name avoids the writer verbs, and the
   * rename costs nothing but a word.
   */
  storeSnapshot?: typeof ForecastSnapshotsRepository.insertSnapshot;
}): Promise<ForecastNightReport> {
  const now = input?.now ?? new Date();
  const issuedOn = isoDay(now);
  const limit = input?.limitProjects ?? 50;
  const fetchTargets = input?.fetchTargets ?? readForecastTargets;
  const fetchReadiness =
    input?.fetchReadiness ?? AuditService.latestReadinessState;
  const readForecast = input?.readForecast ?? readForecastInput;
  const countCitations =
    input?.countCitations ?? GeoAnswerRepository.countRetrievalsAndCitations;
  // **An arrow, and the wrapper is not noise.** `Repository.method` read as a value
  // is an unbound reference, which the type-aware lint refuses on the grounds that
  // it may lose `this`. The repository is a namespace of stateless functions so the
  // binding it would lose does not exist — but writing the forward explicitly is
  // what keeps that true: adding state later breaks the *type* here rather than
  // silently breaking every injected test at runtime.
  const storeSnapshot =
    input?.storeSnapshot ??
    ((row: ForecastSnapshotRow) =>
      ForecastSnapshotsRepository.insertSnapshot(row));

  const report: ForecastNightReport = {
    projectsVisited: 0,
    targetsVisited: 0,
    anchorsStored: 0,
    pacesStored: 0,
    citationWinsStored: 0,
    declined: 0,
    skippedForLimit: 0,
    errors: [],
  };

  const targets = await fetchTargets();
  const admitted = targets.slice(0, limit);
  report.skippedForLimit = targets.length - admitted.length;

  // Grouped by project so readiness is read **once per project** rather than once
  // per target, and so the log can name one. Ordered by first appearance so two
  // nights in a row visit the same projects in the same order.
  const byProject = new Map<string, ForecastTarget[]>();
  for (const target of admitted) {
    const list = byProject.get(target.projectId);
    if (list) list.push(target);
    else byProject.set(target.projectId, [target]);
  }

  for (const [projectId, projectTargets] of byProject) {
    report.projectsVisited += 1;

    // Readiness is a property of the project's newest audit, not of a brand: three
    // targets in one project share one answer to "is this technically quotable".
    let retrievalsComplete: boolean | null = null;
    try {
      const readinessState = await fetchReadiness(projectId);
      retrievalsComplete =
        readinessState === "unknown" ? null : readinessState === "complete";
    } catch (error) {
      // A readiness read that fails is **unknown**, not a penalty: the module it
      // feeds quotes the point estimate for an unknown audit on the grounds that
      // inventing a penalty for a check we never ran is inventing evidence. The
      // failure is reported rather than swallowed, so a broken audit service shows
      // up as a named error instead of as quietly optimistic forecasts.
      report.errors.push(`${projectId}: readiness unreadable`);
      console.error(
        `[cron] Forecast capture could not read readiness for project ${projectId}:`,
        error,
      );
    }

    for (const target of projectTargets) {
      report.targetsVisited += 1;
      try {
        const written = await captureTarget({
          target,
          issuedOn,
          retrievalsComplete,
          readForecast,
          countCitations,
          storeSnapshot,
        });
        report.anchorsStored += written.anchors;
        report.pacesStored += written.paces;
        report.citationWinsStored += written.citationWins;
        report.declined += written.declined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.errors.push(`${projectId}/${target.domain}: ${message}`);
        console.error(
          `[cron] Forecast capture failed for project ${projectId}, target ${target.domain}:`,
          error,
        );
      }
    }
  }

  console.log("[cron] Forecast snapshots complete", {
    projects: report.projectsVisited,
    targets: report.targetsVisited,
    anchors: report.anchorsStored,
    paces: report.pacesStored,
    citationWins: report.citationWinsStored,
    declined: report.declined,
    skipped: report.skippedForLimit,
    errors: report.errors.length,
  });

  return report;
}
