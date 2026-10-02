import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { GeoService } from "@/server/features/geo/services/GeoService";
import { forecastForStoredSeries } from "@/server/features/geo/services/visibilityForecastReads";
import {
  getNewLostSeries,
  getTopCitedPages,
} from "@/server/features/geo/services/geoLiveReads";
import { getAnswerDiff } from "@/server/features/geo/services/answerDiffReads";
import { GEO_PLATFORMS } from "@/types/schemas/geo";
import {
  getEvidenceForSnapshot,
  getSpendReconciliation,
  listEvidencedSnapshots,
} from "@/server/features/geo/services/evidenceDrawer";
import { customerHasPaidPlan } from "@/server/billing/subscription";
import { AppError } from "@/server/lib/errors";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  createGeoPromptSetSchema,
  deleteGeoPromptSetSchema,
  deleteGeoTargetSchema,
  getGeoAiKeywordHistorySchema,
  getGeoAnswerSchema,
  getGeoCitationGapSchema,
  getGeoRunSchema,
  getGeoVisibilitySchema,
  getGeoVisibilityForecastSchema,
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

/**
 * ## The four endpoints below are built, tested, and deliberately unmounted
 *
 * `getGeoAnswer`, `listGeoAnswerHistory`, `getGeoRun` and
 * `getGeoAiKeywordHistory` have no route or component caller. That is a
 * **decision with a screen attached to it**, not an oversight — each names the
 * surface that would want it below, so the next person does not re-derive which
 * four of twenty-three are missing and start looking again.
 *
 * | Endpoint | Reads | The screen that wants it |
 * |---|---|---|
 * | `getGeoAnswer` | one archived answer with its citation and retrieval sets | an answer drawer, reachable from a mention on the trend panel |
 * | `listGeoAnswerHistory` | every answer to one prompt, newest first | the answer diff — the run-over-run comparison behind CL-209 |
 * | `getGeoRun` | one run's snapshot and its per-platform metrics | a run detail, reachable from the runs list |
 * | `getGeoAiKeywordHistory` | monthly AI demand for a keyword | a keyword drill-down from the demand explorer |
 *
 * **A fifth was deleted rather than kept: `getGeoShareOfVoice`.** Its name
 * promised a share of voice and it returned `listCitationDomains` — domains with
 * mention counts, and no competitor set anywhere in the schema. The score
 * component's `shareOfVoice: null` is therefore an *honest refusal* rather than a
 * wiring gap, and keeping an endpoint whose name promises a share it cannot
 * compute is the same defect as the MCP tool that named a tool which did not
 * exist: a false claim in an API surface, found by a reader rather than a test.
 *
 * So the rule is the one this file already follows: **nothing here is a stub.**
 * Each is complete, each is tested, and each is waiting for a screen rather than
 * for someone to remember it.
 */
export const listGeoTargets = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listGeoTargetsSchema)
  .handler(async ({ context }) => GeoService.listTargets(context.projectId));

export const upsertGeoTarget = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(upsertGeoTargetSchema)
  // `projectId` goes LAST in the spread order. Putting it first would let a
  // `projectId` inside the validated body overwrite the authorized context: the
  // schema ignores unknown keys, so that would be a cross-project read or write.
  // (`updateProjectContext` is safe for a different reason — it passes
  // `context.projectId` positionally and never spreads `data`.)
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

/**
 * What changed about one answer between two captures.
 *
 * **The one output this product cannot ship without, and the one no competitor can
 * copy.** Everybody can ask a model a question right now; nobody else can show you
 * the seventh answer. So this is a *pair* comparison the caller names, never a
 * default to "the latest two" — a default would silently change the question
 * whenever a capture lands between render and click.
 *
 * `projectId` comes from the authorized context and never from `data`, and the
 * domain is resolved *within* that project, so a cross-project read is impossible
 * rather than merely discouraged.
 *
 * The refusal travels in the payload: `diff` is null and `noDiffReason` says why,
 * because "only one capture exists" is the normal state for a project on its first
 * night and a throw would leave the panel blank with no explanation.
 */
export const getGeoAnswerDiff = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      domain: z.string().min(1).max(2048),
      prompt: z.string().min(1).max(700),
      platform: z.enum(GEO_PLATFORMS),
      /** Which capture to compare *backwards* from. Omitted means the newest. */
      afterId: z.string().uuid().optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    getAnswerDiff({ ...data, projectId: context.projectId }),
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

export const getGeoEvidence = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      snapshotId: z.string().min(1).max(128),
    }),
  )
  .handler(async ({ data, context }) => {
    // The snapshot id is scoped by the *project* before the drawer is asked, so a
    // snapshot belonging to another organisation returns its "not in the archive"
    // gap rather than its evidence. Without this, the id alone is a capability:
    // anyone who could guess one could read another customer's prompts.
    //
    // The refusal carries the same shape as the success — including a
    // reconciliation of zeroes — because a union of two different shapes here
    // would force every caller to narrow, and the caller that narrowed wrong would
    // render a real cost as `undefined`. One shape, two meanings.
    const owned = await GeoService.ownsSnapshot(
      context.projectId,
      data.snapshotId,
    );
    if (!owned) {
      return {
        answers: [],
        calls: [],
        reconciliation: {
          vendorUsd: 0,
          chargedUsd: 0,
          differenceUsd: 0,
          unpricedCalls: 0,
          note: null,
        },
        gaps: [
          {
            kind: "no_evidence" as const,
            detail:
              "That run is not in this project's archive. The id may be wrong, or the run may belong to another project.",
          },
        ],
      };
    }
    const drawer = await getEvidenceForSnapshot(data.snapshotId);
    return {
      ...drawer,
      reconciliation: await getSpendReconciliation(data.snapshotId),
    };
  });

/**
 * The runs that have evidence behind them — the drawer's index.
 *
 * A snapshot with no recorded call is a dead end: the drawer opens onto "we
 * cannot show our work", which is honest and not useful. So the list only offers
 * the ones a reader can actually open.
 */
export const listGeoEvidencedRuns = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      limit: z.number().int().min(1).max(100).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    listEvidencedSnapshots(context.projectId, data.limit ?? 50),
  );

/**
 * The visibility forecast for one brand on one platform.
 *
 * `projectId` comes from the authorized context and never from `data`, so a
 * caller cannot ask for another organisation's forecast by putting a different
 * id in the request body. The `domain` is validated to be a host-shaped string
 * and is then resolved *within* the authorized project, which is what makes a
 * cross-project read impossible rather than merely discouraged.
 *
 * The refusal travels in the payload rather than as a thrown error. "We have
 * runs and none of them says how many prompts it asked" is the most likely
 * response today, and a throw would leave the panel blank with no explanation —
 * which reads as a broken product rather than a measurement that has not
 * happened yet.
 */
export const getGeoVisibilityForecast = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getGeoVisibilityForecastSchema)
  .handler(async ({ data, context }) =>
    forecastForStoredSeries({
      projectId: context.projectId,
      domain: data.domain,
      platform: data.platform,
    }),
  );

// --- AI demand -------------------------------------------------------------

export const getGeoAiKeywordHistory = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getGeoAiKeywordHistorySchema)
  .handler(async ({ data, context }) =>
    GeoService.getAiKeywordHistory(context.projectId, data.keyword),
  );

/**
 * The stored monthly mentions series, per platform.
 *
 * The market is **not** a parameter: it is read from the target, because that is
 * the market every capture was measured in. Accepting a market here would be an
 * invitation to ask for a series that does not exist and get a plausible-looking
 * answer from a different one.
 */
export const getGeoMentionHistory = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      domain: z.string().min(1).max(2048),
      platform: z.enum(GEO_PLATFORMS),
      limit: z.number().int().min(1).max(60).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    GeoService.getMentionHistory({
      ...data,
      projectId: context.projectId,
    }),
  );

// ---------------------------------------------------------------------------
// Live, metered reads
//
// Everything above is an archive read and costs nothing. These two do not: the
// new/lost counters cannot be derived from stored levels (10 → 12 does not say
// which prompt appeared), and the top-cited ranking is the vendor's current view
// of the whole corpus rather than our per-answer citations. Both hit the vendor,
// so both are gated behind the paid plan in hosted mode — the same rule
// `ai-search` uses, for the same reason.
// ---------------------------------------------------------------------------

async function assertPaidPlanForLiveRead(organizationId: string) {
  if (!(await isHostedServerAuthMode())) return;
  if (await customerHasPaidPlan(organizationId)) return;
  throw new AppError(
    "PAYMENT_REQUIRED",
    "Upgrade to the paid plan to see new and lost mentions, or the live top-cited ranking. The rest of this page is included.",
  );
}

const newLostInputSchema = z.object({
  domain: z.string().min(1).max(2048),
  platform: z.enum(GEO_PLATFORMS),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  groupRange: z.enum(["day", "week", "month"]).optional(),
});

export const getGeoNewLost = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(newLostInputSchema)
  .handler(async ({ data, context }) => {
    await assertPaidPlanForLiveRead(context.organizationId);
    return getNewLostSeries({ ...data, projectId: context.projectId });
  });

const topCitedInputSchema = z.object({
  domain: z.string().min(1).max(2048),
  platform: z.enum(GEO_PLATFORMS),
  limit: z.number().int().min(1).max(100).optional(),
  kind: z.enum(["pages", "domains"]).optional(),
});

export const getGeoTopCited = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(topCitedInputSchema)
  .handler(async ({ data, context }) => {
    await assertPaidPlanForLiveRead(context.organizationId);
    return getTopCitedPages({ ...data, projectId: context.projectId });
  });

/**
 * The stored citation profile — which domains cite this brand, and how often.
 *
 * Archive read, so it costs nothing. It is the input to the visibility score's
 * citation component, and to the panel that names the domains in plain sight.
 */
export const getGeoCitationProfile = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      domain: z.string().min(1).max(2048),
      limit: z.number().int().min(1).max(200).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    GeoService.getCitationProfile({
      ...data,
      projectId: context.projectId,
    }),
  );

/**
 * The earn-the-citation list: which domains the AI answers cite, and whether our
 * link graph can reach any of them.
 *
 * **The inverse of a DR tool, and that is the whole product claim.** AI engines
 * cite low-authority long-tail domains — the proposal names two it saw in the
 * *documented vendor response* — so ranking them by authority puts every domain
 * the models actually use at the bottom.
 *
 * Archive reads only, so it costs nothing, and it carries the caveat its own
 * module always returns: this is **reachability, not authority**. We have no
 * Domain Rating and no traffic estimate; what we have is how many of your pages
 * link to a domain.
 */
export const getGeoCitationGraph = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      domain: z.string().min(1).max(2048),
      limit: z.number().int().min(1).max(200).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    GeoService.getCitationGraph({
      ...data,
      // **The context last, not `...data` last.** Zod objects ignore unknown keys by
      // default, so a `projectId` inside the request body survives validation and a
      // `...data` spread would overwrite the authorized project with the caller's.
      // That is a cross-project read reachable by anyone who can call this. The
      // order here is the whole defence and it looks completely natural backwards.
      projectId: context.projectId,
    }),
  );

// --- ETV series ------------------------------------------------------------

const etvSeriesSchema = z.object({
  domain: z.string().min(1).max(2048),
  endpoint: z
    .enum(["domain_rank_overview", "ranked_keywords", "relevant_pages"])
    .optional()
    .describe(
      "Which Labs endpoint the series came from. Series are never mixed across endpoints.",
    ),
  limit: z.number().int().min(1).max(500).optional(),
});

/**
 * The stored ETV series, with each point's formula version attached.
 *
 * The version travels WITH the value rather than beside it. A chart that has to
 * look the model up separately will eventually draw a mixed series as a clean
 * line, which is the exact failure this endpoint exists to prevent.
 */
export const getGeoEtvSeries = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(etvSeriesSchema)
  .handler(async ({ data, context }) =>
    GeoService.getEtvSeries({
      ...data,
      projectId: context.projectId,
    }),
  );
