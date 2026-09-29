import { createServerFn } from "@tanstack/react-start";
import { GeoService } from "@/server/features/geo/services/GeoService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  createGeoPromptSetSchema,
  deleteGeoPromptSetSchema,
  deleteGeoTargetSchema,
  getGeoAiKeywordHistorySchema,
  getGeoAnswerSchema,
  getGeoCitationGapSchema,
  getGeoRunSchema,
  getGeoShareOfVoiceSchema,
  getGeoVisibilitySchema,
  listGeoAnswerHistorySchema,
  listGeoPromptSetsSchema,
  listGeoRunsSchema,
  listGeoTargetsSchema,
  upsertGeoTargetSchema,
} from "@/types/schemas/geo";

// Thin entry points. `projectId` is never read from `data` — it always comes
// from the authorized context — so a caller cannot read another project's GEO
// data by putting a different id in the request body.

// --- Setup: targets ---------------------------------------------------------

export const listGeoTargets = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listGeoTargetsSchema)
  .handler(async ({ context }) => GeoService.listTargets(context.projectId));

export const upsertGeoTarget = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(upsertGeoTargetSchema)
  // `projectId` goes LAST in the spread order. Putting it first would let a
  // `projectId` inside the validated body overwrite the authorized context -
  // the schema ignores unknown keys, so that would be a cross-project read or
  // write. The sibling projectContext function has the same shape and the same
  // latent ordering; fix both before wiring any UI.
  .handler(async ({ data, context }) =>
    GeoService.upsertTarget({ ...data, projectId: context.projectId }),
  );

export const deleteGeoTarget = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(deleteGeoTargetSchema)
  .handler(async ({ data, context }) =>
    GeoService.deleteTarget(context.projectId, data.targetId),
  );

// --- Setup: prompt sets -----------------------------------------------------

export const listGeoPromptSets = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listGeoPromptSetsSchema)
  .handler(async ({ context }) => GeoService.listPromptSets(context.projectId));

export const createGeoPromptSet = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(createGeoPromptSetSchema)
  .handler(async ({ data, context }) =>
    GeoService.createPromptSet({ ...data, projectId: context.projectId }),
  );

export const deleteGeoPromptSet = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(deleteGeoPromptSetSchema)
  .handler(async ({ data, context }) => {
    await GeoService.deletePromptSet(context.projectId, data.promptSetId);
    return { deleted: true };
  });

// --- Reading the archive ---------------------------------------------------

/**
 * Per-platform visibility. The response is deliberately shaped as buckets keyed
 * by platform so a caller cannot accidentally render a combined total — the two
 * demand figures are not comparable across platforms.
 */
export const getGeoVisibility = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getGeoVisibilitySchema)
  .handler(async ({ data, context }) =>
    GeoService.getVisibility({ ...data, projectId: context.projectId }),
  );

/**
 * Pages a model retrieved without citing. Carries `retrievalAvailable` and a
 * `reason` for platforms that report citations only, so an empty result is
 * explainable rather than merely reassuring.
 */
export const getGeoCitationGap = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getGeoCitationGapSchema)
  .handler(async ({ data, context }) =>
    GeoService.getCitationGap({ ...data, projectId: context.projectId }),
  );

export const getGeoAnswer = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getGeoAnswerSchema)
  .handler(async ({ data, context }) =>
    GeoService.getAnswer(context.projectId, data.answerId),
  );

export const listGeoAnswerHistory = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listGeoAnswerHistorySchema)
  .handler(async ({ data, context }) =>
    GeoService.listAnswerHistory({ ...data, projectId: context.projectId }),
  );

// --- Runs ------------------------------------------------------------------

export const listGeoRuns = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listGeoRunsSchema)
  .handler(async ({ data, context }) =>
    GeoService.listRuns(context.projectId, data.limit),
  );

export const getGeoRun = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getGeoRunSchema)
  .handler(async ({ data, context }) =>
    GeoService.getRun(context.projectId, data.snapshotId),
  );

/** Share of voice for one run, on one platform. Never summed across platforms. */
export const getGeoShareOfVoice = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getGeoShareOfVoiceSchema)
  .handler(async ({ data, context }) =>
    GeoService.getShareOfVoice({ ...data, projectId: context.projectId }),
  );

// --- AI demand -------------------------------------------------------------

export const getGeoAiKeywordHistory = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getGeoAiKeywordHistorySchema)
  .handler(async ({ data, context }) =>
    GeoService.getAiKeywordHistory(context.projectId, data.keyword),
  );
