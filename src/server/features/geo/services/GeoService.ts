/**
 * GEO orchestration: the read and write operations the UI, the agent and the
 * MCP tools all call.
 *
 * Authorization is NOT done here — the caller has already authorized
 * `projectId`, and every repository query is scoped to it. This layer owns id
 * generation, input validation, and translating missing rows into actionable
 * errors.
 *
 * The honesty rules live here too, because this is what the product says:
 * per-platform numbers stay separate, and a platform that reports no retrieval
 * says so rather than returning a confident empty list.
 */
import { AppError } from "@/server/lib/errors";
import { runBatch } from "@/db/runBatch";
import { GeoAnswerRepository } from "@/server/features/geo/repositories/GeoAnswerRepository";
import {
  createPromptSet,
  deletePromptSet,
  listPromptSets,
  promptsForQueuedRun,
} from "./geoPromptSets";
import {
  GEO_PLATFORMS,
  GeoSetupRepository,
  isGeoPlatform,
  platformSupportsRetrieval,
  RETRIEVAL_PLATFORMS,
  type GeoPlatform,
} from "@/server/features/geo/repositories/GeoSetupRepository";
import { GeoRunRepository } from "@/server/features/geo/repositories/GeoRunRepository";
import { writeRunRollups } from "./runRollups";
import {
  getEtvSeries,
  getMentionHistory,
} from "@/server/features/geo/services/geoSeriesReads";
import { GeoRetentionRepository } from "@/server/features/geo/repositories/GeoRetentionRepository";
import { getCitationGraph as buildCitationGraphFor } from "@/server/features/geo/services/geoCitationGraph";

/** Normalise a brand to a bare lowercase host, so "HTTPS://WWW.Acme.com/x" and
 * "acme.com" resolve to the same monitored target. */
function normaliseDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .trim();
}

function requireDomain(input: string | undefined): string {
  const domain = normaliseDomain(input ?? "");
  if (!domain || !domain.includes(".")) {
    throw new AppError(
      "VALIDATION_ERROR",
      `"${input ?? ""}" is not a valid domain. Pass a bare host such as acme.com.`,
    );
  }
  return domain;
}

function requirePlatform(input: unknown): GeoPlatform {
  if (!isGeoPlatform(input)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Unknown platform "${String(input)}". Supported: ${GEO_PLATFORMS.join(", ")}.`,
    );
  }
  return input;
}

function notFound(what: string, id: string) {
  return new AppError(
    "NOT_FOUND",
    `No ${what} ${id} in this project. Call listTargets to see what exists.`,
  );
}

// ---------------------------------------------------------------------------
// Setup: targets and prompt sets
// ---------------------------------------------------------------------------

async function listTargets(projectId: string) {
  return GeoSetupRepository.listTargets(projectId);
}

/** Add or update a monitored brand. Idempotent on domain + market. */
async function upsertTarget(input: {
  projectId: string;
  domain: string;
  name?: string;
  aliases?: string[];
  locationCode: number;
  languageCode: string;
}) {
  const domain = requireDomain(input.domain);
  const targetId = crypto.randomUUID();
  await runBatch((tx) => [
    GeoSetupRepository.upsertTarget(tx, {
      id: targetId,
      projectId: input.projectId,
      domain,
      name: input.name?.trim() || domain,
      aliases: input.aliases?.join(", ") || null,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
    }),
  ]);
  const saved = await GeoSetupRepository.listTargets(input.projectId);
  return saved.find((row) => row.domain === domain) ?? null;
}

async function deleteTarget(projectId: string, targetId: string) {
  await runBatch((tx) => [
    GeoSetupRepository.deleteTarget(tx, projectId, targetId),
  ]);
  const remaining = await GeoSetupRepository.getTarget(projectId, targetId);
  return remaining === null;
}

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

/**
 * Per-platform visibility for a target. Two numbers, never one.
 *
 * The caller renders each platform separately; this function exists partly to
 * make merging awkward and to keep the platform label attached to every figure.
 */
async function getVisibility(input: {
  projectId: string;
  targetId: string;
  platforms?: GeoPlatform[];
}) {
  const target = await GeoSetupRepository.getTarget(
    input.projectId,
    input.targetId,
  );
  if (!target) throw notFound("target", input.targetId);

  const platforms = input.platforms ?? [...GEO_PLATFORMS];
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  return {
    target,
    since,
    perPlatform: await Promise.all(
      platforms.map(async (platform) => ({
        platform,
        mentions: await GeoAnswerRepository.countAnswers(
          input.projectId,
          platform,
        ),
        recent: await GeoAnswerRepository.listAnswersForTarget(
          input.projectId,
          input.targetId,
          platform,
          { since, limit: 200 },
        ),
      })),
    ),
  };
}

/**
 * The citation gap: pages a model retrieved without citing.
 *
 * `retrievalAvailable` is false for Google AI Overviews, because DataForSEO does
 * not return its retrieval list. Returning that flag lets the caller say why
 * the list is empty instead of implying the brand has no gap.
 */
async function getCitationGap(input: {
  projectId: string;
  targetId: string;
  platform: unknown;
  domain?: string;
  since?: string;
  limit?: number;
}) {
  const platform = requirePlatform(input.platform);
  const target = await GeoSetupRepository.getTarget(
    input.projectId,
    input.targetId,
  );
  if (!target) throw notFound("target", input.targetId);

  if (!platformSupportsRetrieval(platform)) {
    return {
      platform,
      retrievalAvailable: false as const,
      reason:
        `DataForSEO returns citations for ${platform} but not the pages Google retrieved, ` +
        `so the retrieved-but-uncited gap is only available for ${RETRIEVAL_PLATFORMS.join(", ")}.`,
      gaps: [],
    };
  }

  return {
    platform,
    retrievalAvailable: true as const,
    domain: input.domain ?? target.domain,
    gaps: await GeoAnswerRepository.listCitationGaps(
      input.projectId,
      input.targetId,
      platform,
      input.domain ?? target.domain,
      { since: input.since, limit: input.limit ?? 100 },
    ),
  };
}

/** One archived answer with its citation, retrieval and fan-out sets. */
async function getAnswer(projectId: string, answerId: string) {
  const found = await GeoAnswerRepository.getAnswerWithSets(
    projectId,
    answerId,
  );
  if (!found) throw notFound("answer", answerId);
  return found;
}

/** The answer series for one prompt, newest first — the diff input. */
async function listAnswerHistory(input: {
  projectId: string;
  prompt: string;
  platform: unknown;
  limit?: number;
}) {
  const platform = requirePlatform(input.platform);
  return GeoAnswerRepository.listAnswersForPrompt(
    input.projectId,
    input.prompt,
    platform,
    input.limit ?? 50,
  );
}

/**
 * Record a run: open the snapshot, archive the answers, write the per-platform
 * rollups, close the snapshot with what it cost.
 *
 * The snapshot and its answers are written in one transaction so a partial run
 * can never leave a snapshot claiming success with no answers behind it.
 */
async function recordRun(input: {
  projectId: string;
  promptSetId?: string;
  targetId?: string;
  createdBy: "user" | "sam" | "mcp" | "schedule";
  answers: Parameters<typeof GeoAnswerRepository.insertAnswers>[0];
  costUsd?: number;
  /**
   * How many prompts this run asked, or null when the acquisition path cannot
   * say. Written at insert rather than at completion, because the answers are
   * what make the count meaningful and the run row is the only place the pair
   * can be kept together.
   */
  promptsAsked?: number | null;
}) {
  const snapshotId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  await runBatch((tx) => [
    GeoRunRepository.insertSnapshot(tx, {
      id: snapshotId,
      projectId: input.projectId,
      promptSetId: input.promptSetId ?? null,
      // **Accepted and then dropped** until CL-501e added the column. `GeoPatrol`
      // has always passed the target it is measuring, so the brand identity was
      // threaded all the way here and discarded — and the alerting reader then
      // compared a run against "the previous run in this project", which in a
      // multi-brand project is a *different brand's* run.
      targetId: input.targetId ?? null,
      startedAt,
      status: "running",
      createdBy: input.createdBy,
      // `?? null` rather than a default of 0. A caller that omits this has not
      // told us anything about the sample, and defaulting to 0 would state that
      // no prompts were asked — which is a measurement, not an absence of one.
      promptsAsked: input.promptsAsked ?? null,
    }),
  ]);

  /**
   * The snapshot is marked `failed` if archiving throws, so an interrupted run
   * cannot sit at `running` forever.
   *
   * This is three awaited steps, and until now only the last one recorded the
   * outcome. A throw in the middle — a vendor payload the parser refuses, a
   * foreign-key failure, a dropped connection — left the row at `running`
   * permanently, and `running` is invisible to both consumers: the alerting
   * reader filters to `complete`, and the forecast reads whatever runs it finds.
   *
   * So the failure was invisible twice over. Nobody was told the run had failed,
   * and the runs *around* it were compared as though this one had never been
   * attempted — which is a gap in the history that no query can explain, because
   * the row that would explain it is sitting in the table saying `running`.
   *
   * Best-effort by design: if the cleanup write itself fails there is nothing
   * useful left to do, and swallowing is better than replacing the original error
   * with a less useful one.
   */
  try {
    await GeoAnswerRepository.insertAnswers(input.answers, snapshotId);

    /**
     * The two per-run rollups — mentions per platform, and the citing domains per
     * platform — reduced from the answers just archived.
     *
     * **Both writers had never been called**, so both tables were empty and every
     * surface on them was reading zero rows: the drawer's "What the vendor reported",
     * `getGeoRun`, and the "Earn the citation" panel, which has been drawing an empty
     * chart on every project since it shipped.
     *
     * **After the answers, not beside them** — it is a reduction over those rows.
     *
     * **Best-effort, and deliberately so:** a rollup that fails must not fail a patrol
     * whose answers are already archived. The failure is logged rather than swallowed
     * silently, because a missing rollup is a missing rollup and should be visible as
     * one.
     *
     * The domain comes from the **target**, resolved once here rather than inside the
     * reduction, so the mention judgement uses the same brand identity the archive was
     * built from.
     */
    const rollupTarget = input.targetId
      ? await GeoSetupRepository.getTarget(input.projectId, input.targetId)
      : null;
    await writeRunRollups({
      projectId: input.projectId,
      snapshotId,
      targetId: input.targetId,
      domain: rollupTarget?.domain ?? undefined,
      brandName: rollupTarget?.name ?? undefined,
      answers: input.answers,
    }).catch((error: unknown) => {
      console.error(`[geo] rollups failed for snapshot ${snapshotId}:`, error);
    });

    await runBatch((tx) => [
      GeoRunRepository.completeSnapshot(tx, snapshotId, {
        status: "complete",
        costUsd: input.costUsd,
      }),
    ]);
  } catch (error) {
    await runBatch((tx) => [
      GeoRunRepository.completeSnapshot(tx, snapshotId, { status: "failed" }),
    ]).catch(() => {
      // Deliberately swallowed — see above.
    });
    throw error;
  }

  return GeoRunRepository.getSnapshot(input.projectId, snapshotId);
}

async function listRuns(projectId: string, limit = 50) {
  return GeoRunRepository.listSnapshots(projectId, limit);
}

/** The per-platform demand series for a run. Callers must not sum the values. */
async function listRunDemand(
  projectId: string,
  snapshotId: string,
): Promise<
  Array<{
    platform: string;
    mentions: number | null;
    aiSearchVolume: number | null;
  }>
> {
  const metrics = await GeoRunRepository.listTargetMetrics(
    projectId,
    snapshotId,
  );
  return metrics.map((row) => ({
    platform: row.platform,
    mentions: row.mentions,
    aiSearchVolume: row.aiSearchVolume,
  }));
}

async function getRun(projectId: string, snapshotId: string) {
  const snapshot = await GeoRunRepository.getSnapshot(projectId, snapshotId);
  if (!snapshot) throw notFound("run", snapshotId);
  return {
    snapshot,
    metrics: await GeoRunRepository.listTargetMetrics(projectId, snapshotId),
  };
}

/**
 * Is this snapshot one of the project's?
 *
 * Exists because the evidence drawer is the first read in this feature that takes
 * a bare snapshot id and could otherwise scope itself on the id alone. Every other
 * run read goes through `getRun`, which passes `projectId` into the repository and
 * so filters by it; the drawer's repository functions do not, because the drawer is
 * also called from the drain and the patrol where the snapshot was just written.
 *
 * So the check is here, at the boundary, and the drawer's own functions are left
 * unscoped for their internal callers. One check, at the edge, beats a project
 * parameter threaded through four functions that mostly do not have one.
 */
async function ownsSnapshot(
  projectId: string,
  snapshotId: string,
): Promise<boolean> {
  const snapshot = await GeoRunRepository.getSnapshot(projectId, snapshotId);
  return snapshot !== null;
}

/** AI demand history for a keyword. Missing months stay missing. */
async function getAiKeywordHistory(projectId: string, keyword: string) {
  return GeoRunRepository.listAiKeywordHistory(
    projectId,
    normaliseKeyword(keyword),
  );
}

/**
 * The citation profile for a target's most recent run, per platform.
 *
 * `geo_citation_domains` is keyed on (snapshot, platform) and the page has no
 * snapshot id, so the service resolves the latest run and then asks which
 * platforms it covered — `geo_target_metrics` is what records that, and
 * re-deriving it from the answers would be a second source of truth.
 *
 * The `limit` bounds the entropy calculation without pretending the bound is
 * the truth: a brand cited by 400 domains and counted on the top 50 will read as
 * more concentrated than it is, which is why the client's summary names the
 * count it used.
 */
async function getCitationProfile(input: {
  projectId: string;
  domain: string;
  limit?: number;
}) {
  const target = await GeoSetupRepository.getTargetByDomain(
    input.projectId,
    normaliseDomain(input.domain),
  );
  if (!target) {
    throw new AppError(
      "NOT_FOUND",
      `${input.domain} is not a monitored target in this project, so it has no citation profile.`,
    );
  }

  const [latest] = await GeoRunRepository.listSnapshots(input.projectId, 1);
  if (!latest) return [];

  const metrics = await GeoRunRepository.listTargetMetrics(
    input.projectId,
    latest.id,
  );
  const platforms = [
    ...new Set(
      metrics
        .map((row) => row.platform)
        .filter((platform): platform is GeoPlatform => Boolean(platform)),
    ),
  ];

  return Promise.all(
    platforms.map(async (platform) => ({
      platform,
      snapshotId: latest.id,
      domains: await GeoRunRepository.listCitationDomains(
        input.projectId,
        latest.id,
        platform,
        input.limit ?? 50,
      ),
    })),
  );
}

/**
 * The earn-the-citation list.
 *
 * A thin delegation: the assembly lives in `geoCitationGraph` because it is
 * reachability reporting rather than a read of one table, and inlining it here put
 * this file over the 400-line rule.
 */
async function getCitationGraph(input: {
  projectId: string;
  domain: string;
  limit?: number;
}) {
  return buildCitationGraphFor(input);
}

function normaliseKeyword(keyword: string): string {
  return keyword.trim().toLowerCase();
}

/**
 * Drop archived answers past the retention window.
 *
 * Snapshots survive their answers: the run's cost, status and window are the
 * audit trail, and that has to stay answerable after the text ages out.
 */
async function purgeExpiredAnswers(
  projectId: string,
  env: object,
  now?: Date,
): Promise<{ answersDeleted: number; cutoff: string }> {
  const cutoff = GeoRetentionRepository.cutoffFor(env, now);
  const answersDeleted = await GeoRetentionRepository.purgeAnswersBefore(
    projectId,
    cutoff,
  );
  return { answersDeleted, cutoff };
}

export const GeoService = {
  listTargets,
  upsertTarget,
  deleteTarget,
  listPromptSets,
  promptsForQueuedRun,
  createPromptSet,
  deletePromptSet,
  getVisibility,
  getCitationGap,
  getAnswer,
  listAnswerHistory,
  recordRun,
  listRuns,
  listRunDemand,
  getRun,
  ownsSnapshot,
  getAiKeywordHistory,
  getEtvSeries,
  getMentionHistory,
  getCitationProfile,
  getCitationGraph,
  purgeExpiredAnswers,
} as const;
