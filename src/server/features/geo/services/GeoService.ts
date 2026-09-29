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
  GEO_PLATFORMS,
  GeoSetupRepository,
  isGeoPlatform,
  platformSupportsRetrieval,
  RETRIEVAL_PLATFORMS,
  type GeoPlatform,
} from "@/server/features/geo/repositories/GeoSetupRepository";
import { GeoRunRepository } from "@/server/features/geo/repositories/GeoRunRepository";
import { GeoRetentionRepository } from "@/server/features/geo/repositories/GeoRetentionRepository";

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

async function listPromptSets(projectId: string) {
  const sets = await GeoSetupRepository.listPromptSets(projectId);
  return Promise.all(
    sets.map(async (set) => ({
      ...set,
      prompts: await GeoSetupRepository.listPrompts(projectId, set.id),
    })),
  );
}

/** Create a prompt set and its prompts in one atomic batch. */
async function createPromptSet(input: {
  projectId: string;
  name: string;
  description?: string;
  prompts: Array<{ prompt: string; intent?: string | null }>;
}) {
  if (input.prompts.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "A prompt set needs at least one prompt. Add prompts before saving.",
    );
  }
  const setId = crypto.randomUUID();
  await runBatch((tx) => [
    GeoSetupRepository.insertPromptSet(tx, {
      id: setId,
      projectId: input.projectId,
      name: input.name.trim(),
      description: input.description ?? null,
    }),
    ...GeoSetupRepository.insertPrompts(tx, setId, input.prompts),
  ]);
  const set = await GeoSetupRepository.getPromptSet(input.projectId, setId);
  if (!set) throw notFound("prompt set", setId);
  return set;
}

/** Delete a prompt set. Its prompts cascade. */
async function deletePromptSet(projectId: string, promptSetId: string) {
  await runBatch((tx) => [
    GeoSetupRepository.deletePromptSet(tx, projectId, promptSetId),
  ]);
  return (
    (await GeoSetupRepository.getPromptSet(projectId, promptSetId)) === null
  );
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
}) {
  const snapshotId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  await runBatch((tx) => [
    GeoRunRepository.insertSnapshot(tx, {
      id: snapshotId,
      projectId: input.projectId,
      promptSetId: input.promptSetId ?? null,
      startedAt,
      status: "running",
      createdBy: input.createdBy,
    }),
  ]);
  await GeoAnswerRepository.insertAnswers(input.answers, snapshotId);
  await runBatch((tx) => [
    GeoRunRepository.completeSnapshot(tx, snapshotId, {
      status: "complete",
      costUsd: input.costUsd,
    }),
  ]);

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

/** Share of voice for one run, per platform. Never summed across platforms. */
async function getShareOfVoice(input: {
  projectId: string;
  snapshotId: string;
  platform: unknown;
  limit?: number;
}) {
  const platform = requirePlatform(input.platform);
  return GeoRunRepository.listCitationDomains(
    input.projectId,
    input.snapshotId,
    platform,
    input.limit ?? 25,
  );
}

/** AI demand history for a keyword. Missing months stay missing. */
async function getAiKeywordHistory(projectId: string, keyword: string) {
  return GeoRunRepository.listAiKeywordHistory(
    projectId,
    normaliseKeyword(keyword),
  );
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
  getShareOfVoice,
  getAiKeywordHistory,
  purgeExpiredAnswers,
} as const;
