import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import {
  buildLlmTarget,
  CHATGPT_LANGUAGE_CODE,
  CHATGPT_LOCATION_CODE,
  type LlmPlatform,
} from "@/server/lib/dataforseo/shared";
import { GeoService } from "@/server/features/geo/services/GeoService";
import {
  planPosts,
  postBatch,
  queueNote,
  type AcquisitionMode,
  type QueueCandidate,
} from "@/server/features/geo/services/queuePlanner";
import { recordVendorTask } from "@/server/features/geo/services/vendorTaskRecorder";
import { GeoSetupRepository } from "@/server/features/geo/repositories/GeoSetupRepository";
import type { GeoAnswerInsert } from "@/server/features/geo/repositories/GeoAnswerRepository";
import { platformSupportsRetrieval } from "@/server/features/geo/repositories/GeoSetupRepository";
import type { GeoPlatform } from "@/server/features/geo/repositories/GeoSetupRepository";
import type { LlmMentionItem } from "@/server/lib/dataforseoLlmSchemas";
import type { BillingCustomerContext } from "@/server/billing/subscription";

/**
 * The patrol: fetch AI answers for a target and archive them as one run.
 *
 * This is the thing that makes the archive fill. Without it the schema is
 * inert — a visibility score with no history is a commodity, and history is the
 * moat. Every run stores the exact prompt, the citation and retrieval sets, and
 * the vendor's own response timestamps, so a later run can answer "did this
 * change, and why".
 *
 * Three vendor constraints shape this file, and every one of them is a silent
 * failure rather than an error:
 *
 * 1. **The llm_mentions API serves only two platforms**: `chat_gpt` and
 *    `google`. Our richer four-platform vocabulary is ours, so it is mapped
 *    explicitly and an unmapped platform is reported rather than sent.
 * 2. **ChatGPT mention data is US/en only.** Any other market returns an empty
 *    set that is indistinguishable from "you are not mentioned". We query the
 *    market the vendor actually serves and record that we did.
 * 3. **The payload does not separate retrieved from cited.** So `sources` becomes
 *    citations for every platform, and retrievals *only* for ChatGPT, where the
 *    vendor does report a retrieval list. Claiming a retrieval we did not
 *    observe would invent the gap — the one signal this product exists to sell.
 */

/** What one patrol run produced. */
type PatrolRunResult = {
  snapshotId: string | null;
  /**
   * **Every** snapshot the run wrote, one per target.
   *
   * `snapshotId` is the first of these and is kept because the run log and
   * `alertOnRunChange`'s primary path read it. It is **not** enough on its own:
   * `GeoPatrol.run` calls `runForTarget` once per target, so a three-brand
   * patrol writes three snapshots and returning only the first meant two brands
   * were never alerted on at all.
   *
   * Kept as a list rather than replacing the scalar, because a scalar that
   * silently means "the first one" is what caused the gap; a caller that reads
   * `snapshotId` can still tell it is the first, and one that wants every brand
   * reads this.
   */
  snapshotIds: string[];
  answersArchived: number;
  /** Vendor cost in USD, summed from the task costs actually returned. */
  costUsd: number;
  /**
   * How many prompts this run asked, or null when the acquisition path cannot
   * say. Not optional: every branch has to answer, because a branch that
   * forgets is exactly how a run ends up with a denominator nobody chose.
   */
  promptsAsked: number | null;
  /** Human-readable notes for the run log. A platform we skipped belongs here. */
  notes: string[];
};

// Not exported: the server function layer consumes the service, not these types.
// Exporting them would be a claim about the API surface nothing has used yet.
type PatrolInput = {
  projectId: string;
  /**
   * The caller's billing context, threaded through to the metered client.
   * Required rather than constructed here: the client checks usage credits
   * against it, and a fabricated context would let a patrol spend real money
   * with no budget behind it.
   */
  customer: BillingCustomerContext;
  targetId?: string;
  promptSetId?: string;
  platforms?: GeoPlatform[];
  createdBy: "user" | "sam" | "mcp" | "schedule";
  /**
   * Cap on answers archived for the whole run, so a misconfigured prompt set
   * cannot run up a large bill without a human noticing.
   */
  maxAnswers?: number;
  /**
   * How this run obtains its answers. **Defaults to `live`**, and the queue is
   * opt-in per run rather than the default — see `queuePlanner` for why: the
   * queue is ~30% cheaper and up to 72 hours slower, and switching by default
   * would leave every surface rendering an empty archive for three days with no
   * error anywhere. A gate in `scripts/acquisition-mode-gate.test.ts` fails the
   * build if that default is ever changed without the change being argued for.
   */
  mode?: AcquisitionMode;
  /**
   * The prompts to ask, required in `queued` mode and ignored in `live`.
   *
   * Explicit rather than derived, because the two paths measure different
   * things: `llm_mentions` takes a **brand** and reports a mention, while
   * `llm_responses` takes a **question** and returns an answer. Deriving one from
   * the other would put a mention count where an answer is expected.
   */
  queuePrompts?: string[];
};

const DEFAULT_MAX_ANSWERS = 500;

/**
 * The model a queued run asks when the caller names none.
 *
 * A named constant rather than an inline literal because a model's name is also
 * its **price**, and a queue run that silently switched models would change what
 * a run costs without changing anything a reader can see. The catalog in
 * `llm-models.ts` is the authority; this is the documented default, not a
 * discovery.
 */
const QUEUE_DEFAULT_MODEL = "gpt-5";

/**
 * The run-log sentence for a platform nothing collects.
 *
 * One function for both acquisition paths, because the two notes were separate
 * strings that could disagree about the same platform — and the queued one had
 * drifted into **naming a collector that does not exist**. It said the platform was
 * handled by a mode monitor, and no such monitor runs: `planAiModeCaptures` has
 * tests and no caller, `fetchAiModeAnswer` is reached only through the SDK meter's
 * method reference, and `tryBeginRun` is used solely by this patrol.
 *
 * The sentence has to be true, and the truth is also the more useful thing to tell
 * a reader: this platform is not collected, and nothing else is collecting it
 * either. A reader who believes a monitor has it stops looking; a reader told the
 * gap is real knows to escalate it.
 *
 * `scripts/acquisition-mode-gate.test.ts` asserts this text by reading the file —
 * **including that the old claim is absent from it** — so a note that names a
 * monitor has to argue with a test rather than with a reviewer's memory. The gate
 * is a source scan by design and cannot import this module (it would drag in
 * `cloudflare:workers` through the billing module), and the first version tried to
 * and failed with `Cannot find package 'cloudflare:workers'`. A scan that has to
 * boot the worker is no longer a scan.
 *
 * Not exported: the gate reads the source rather than the function, and an export
 * with no importer is exactly what `knip` exists to refuse. The first version
 * exported it for the gate's benefit and was told so.
 */
function uncollectedPlatformNote(platform: string): string {
  return (
    `${platform} is not collected. The llm_mentions and llm_responses ` +
    `endpoints serve ChatGPT and Google only, and no other job in this ` +
    `product collects ${platform} — so a run that included it will always ` +
    `report a gap there, and the gap is real rather than a delay.`
  );
}

/**
 * The platforms each vendor endpoint serves, mapped from ours.
 *
 * `llm_mentions` and `llm_responses` are ChatGPT and Google only, which is why
 * `gemini` and `perplexity` are in the product's vocabulary but not here. A
 * platform absent from this map is one nothing collects, and both paths say so
 * with `uncollectedPlatformNote` rather than inventing a collector.
 */
const PLATFORM_TO_VENDOR: Partial<Record<GeoPlatform, LlmPlatform>> = {
  chat_gpt: "chat_gpt",
  google_ai_overview: "google",
};

/** Normalise a URL to a bare host, for the domain column and the gap query. */
function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    // A malformed URL is still evidence; keep the raw string rather than
    // dropping the citation entirely.
    return url.split("/")[0]?.toLowerCase() || null;
  }
}

/**
 * Map one vendor mention row into the rows we store.
 *
 * `answerText` is null because llm_mentions returns no answer body — only the
 * question, the sources and the demand figures. Storing an empty string instead
 * would read as "the model answered nothing", which is a different claim.
 */
function toAnswerRow(input: {
  answerId: string;
  projectId: string;
  targetId?: string;
  promptSetId?: string;
  platform: GeoPlatform;
  locationCode: number;
  languageCode: string;
  item: LlmMentionItem;
}): GeoAnswerInsert | null {
  const prompt = input.item.question?.trim();
  if (!prompt) return null;

  const sources = input.item.sources ?? [];
  const urls = new Set<string>();
  for (const source of sources) {
    if (source.url) urls.add(source.url);
  }

  const citations = [...urls].map((url, index) => ({
    url,
    domain: hostOf(url),
    title: sources.find((s) => s.url === url)?.title ?? null,
    snippet: null,
    rank: index + 1,
  }));

  // Retrievals come from `search_results` — "all web search outputs the model
  // retrieved while looking up information, including duplicates and unused
  // entries" — which is a SUPERSET of `sources` ("the sources the model cited or
  // relied on in its final answer").
  //
  // That difference is the retrieved-but-uncited gap, which is the one thing
  // this product sells. An earlier version of this file copied the citation set
  // into retrievals, which made the gap permanently empty: every retrieved page
  // matched a cited page and the LEFT JOIN found nothing. The page looked right
  // and the feature did not work.
  //
  // `search_results` is chat_gpt-only (DataForSEO returns null for google), which
  // is the same limitation `RETRIEVAL_PLATFORMS` encodes — so this is the one
  // place that guard is applied, and the reason for it is the field, not a
  // platform name.
  const retrievals = input.item.search_results
    ?.map((result, index) => ({
      url: result.url ?? "",
      domain: result.url ? hostOf(result.url) : (result.domain ?? null),
      rank: index + 1,
    }))
    .filter((entry) => entry.url.length > 0);

  return {
    answer: {
      id: input.answerId,
      projectId: input.projectId,
      targetId: input.targetId ?? null,
      promptSetId: input.promptSetId ?? null,
      prompt,
      answerText: null,
      platform: input.platform,
      modelName: null,
      source: "mentions_search" as const,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      // The vendor gives a first/last response window, not a per-answer
      // timestamp. `last_response_at` is the closest honest stamp.
      answeredAt:
        input.item.last_response_at ?? input.item.first_response_at ?? "",
      vendorTaskId: null,
      rawJson: JSON.stringify(input.item),
    },
    citations,
    // `undefined` rather than `[]` when the vendor reported no retrieval list:
    // "we have no retrieval data" and "the model retrieved nothing" are
    // different claims, and only the first is true for google.
    retrievals: platformSupportsRetrieval(input.platform)
      ? retrievals
      : undefined,
  };
}

type Client = ReturnType<typeof createDataforseoClient>;

type PatrolTarget = {
  id: string;
  domain: string;
  locationCode: number;
  languageCode: string;
};

async function runForTarget(
  client: Client,
  input: PatrolInput,
  target: PatrolTarget,
  platforms: GeoPlatform[],
  budget: number,
): Promise<PatrolRunResult> {
  const notes: string[] = [];
  const inserts: GeoAnswerInsert[] = [];
  // The metered client returns the payload directly and captures cost in the
  // billing ledger, so a run cannot see the vendor's charge to record it here.
  // `costUsd` therefore reports 0 for a metered run: a snapshot must never carry
  // an *estimated* figure in a column a reader would take for a receipt.
  let costUsd = 0;
  let remaining = budget;
  /**
   * The number of prompts this run actually put to a model, which is the
   * denominator every rate about it depends on.
   *
   * **Null, and the distinction is the whole point of the column.** The Live path
   * calls `llm_mentions/search`, which takes a **domain** and returns only the
   * prompts that mentioned the brand. The vendor chooses the prompt set and never
   * discloses how many it asked — `limit` is a cap on *results*, not a count of
   * questions, so a run that returns 4 mentions was asked some unknown number of
   * prompts that is certainly not 4, and not 100 either.
   *
   * So for the Live path this stays **null**: we hold a numerator and a total we
   * were never told. Writing `limit` here would be the most plausible wrong
   * number available, and it is wrong in the flattering direction — a large
   * assumed denominator makes a handful of mentions look like a small share
   * rather than an unmeasurable one. An exact-sounding rate built on a
   * `LIMIT` clause is a lie with an API shape to it.
   *
   * The queue path, which takes an explicit prompt and returns that prompt's
   * answer, *does* know its denominator, and records it. That asymmetry is the
   * honest state of the product today: we can forecast our own questions, and we
   * cannot forecast the vendor's.
   */
  let promptsAsked: number | null = null;

  // The queue branch, taken before any Live call so a queued run does not also
  // pay for the Live path. It returns early with an empty archive on purpose:
  // there is no answer to archive yet, and a snapshot containing a pending task
  // would render as a visibility result the product cannot yet support.
  //
  // ## The two paths ask different questions, and that is the honest limit here
  //
  // The Live path calls `llm_mentions/search`, which takes a **brand** and
  // returns whether it was mentioned — no prompt, no answer text. The queued
  // `llm_responses` endpoint takes a **prompt** and returns the answer. So a
  // queued run is not a cheaper version of the Live run; it is a *different
  // measurement*, and one the archive has no table for yet.
  //
  // So the branch does not guess. It requires the caller to supply the prompts
  // explicitly, refuses to invent them from the target, and says in the run log
  // which of the two happened. Guessing here would produce an archive that looks
  // like the Live one and is not — a mention count rendered where a share of
  // voice is expected.
  if (input.mode === "queued") {
    // **The prompts come from the project, not from the caller.** This branch was
    // built, tested and dormant for exactly one reason: it required
    // `input.queuePrompts` and nothing in production ever supplied one. The
    // questions a queued run asks were always meant to be *ours* — that is the
    // whole difference between the two paths, and it is the only reason the queued
    // path can compute a denominator the Live one cannot.
    //
    // A caller may still pass them explicitly, and that path is kept: a caller with
    // prompts in hand (a test, a future importer) should not have to write them to
    // the database first. But the default is now the project's saved set, so the
    // branch is reachable.
    //
    // **Per project, not per target**, and that is deliberate: the prompt set is
    // the project's, so a three-brand project asks the same three questions of each
    // brand and gets three comparable answers. The tag carries the brand, so the
    // archive can tell them apart — which is the same reason `observationKey`
    // includes the domain.
    const prompts =
      input.queuePrompts ??
      (await GeoService.promptsForQueuedRun(input.projectId));
    if (prompts.length === 0) {
      return {
        snapshotId: null,
        snapshotIds: [],
        answersArchived: 0,
        costUsd: 0,
        // A measured zero, and the distinction from null is the whole point of
        // the column: this run was asked to post prompts and posted none, which
        // we know exactly. `null` means we cannot say what was asked, and turning
        // a refusal into a zero would let a misconfigured caller read as a clean
        // run that found nothing.
        promptsAsked: 0,
        notes: [
          ...notes,
          // **The note says what to do**, because a refusal that does not is a
          // support ticket. This project has no saved prompts, so there is nothing
          // to ask — and the one action that fixes it is named.
          "Queued mode asks questions and returns answers, so it needs prompts to ask, and this project has none saved. Add a prompt set in GEO settings, or switch this project back to the live path, which asks about a brand and reports whether it was mentioned. Nothing was posted.",
        ],
      };
    }

    const candidates: QueueCandidate[] = [];
    for (const platform of platforms) {
      if (remaining <= 0) {
        notes.push(
          `Stopped at the ${budget}-answer cap; ${platform} and later platforms were not posted.`,
        );
        break;
      }
      const vendorPlatform = PLATFORM_TO_VENDOR[platform];
      if (!vendorPlatform) {
        notes.push(uncollectedPlatformNote(platform));
        continue;
      }
      for (const prompt of prompts) {
        if (remaining <= 0) break;
        candidates.push({
          prompt,
          targetId: target.id,
          platform: vendorPlatform === "google" ? "gemini" : "chat_gpt",
          modelName: QUEUE_DEFAULT_MODEL,
        });
        remaining -= 1;
      }
    }

    if (candidates.length === 0) {
      return {
        snapshotId: null,
        snapshotIds: [],
        answersArchived: 0,
        costUsd: 0,
        // Zero, not null. The run asked nothing because there was nothing to
        // ask, which is a measured zero rather than a measurement we failed to
        // take — and the two render differently on a dashboard.
        promptsAsked: 0,
        notes: [
          ...notes,
          "Nothing was posted: the capture plan had no prompts for this target.",
        ],
      };
    }

    // Grouped by platform because the queued endpoint is platform-scoped — a
    // single `se` per post, and posting a Gemini prompt to the ChatGPT path
    // would return a plausible answer about the wrong model.
    const byPlatform = new Map<QueueCandidate["platform"], QueueCandidate[]>();
    for (const candidate of candidates) {
      const list = byPlatform.get(candidate.platform);
      if (list) list.push(candidate);
      else byPlatform.set(candidate.platform, [candidate]);
    }

    let posted = 0;
    let accepted = 0;
    let rejected = 0;
    let offset = 0;
    for (const [platform, group] of byPlatform) {
      for (const batch of planPosts(group)) {
        const outcome = await postBatch(platform, batch, offset);
        offset += batch.length;
        posted += batch.length;
        if (!outcome.posted) {
          notes.push(outcome.reason);
          rejected += batch.length;
          continue;
        }
        accepted += outcome.accepted;
        rejected += outcome.rejected;
        costUsd += outcome.advanceUsd;
      }
    }

    notes.push(queueNote({ posted, accepted, rejected }));
    // No snapshot, no answers: the run started work, and saying otherwise is the
    // failure this whole branch exists to avoid.
    //
    // `promptsAsked` is still reported because it is the one number the queued
    // path genuinely knows — the number of questions it submitted — and it is
    // what makes the drain's eventual answers a measurable series rather than a
    // list of arrivals. The drain fills in `answersArchived`; this fills in the
    // denominator. Neither is useful alone, and the gap between them is the
    // coverage figure a reader needs.
    return {
      snapshotId: null,
      snapshotIds: [],
      answersArchived: 0,
      costUsd,
      promptsAsked: posted,
      notes,
    };
  }

  for (const platform of platforms) {
    if (remaining <= 0) {
      notes.push(
        `Stopped at the ${budget}-answer cap; ${platform} and later platforms were not queried.`,
      );
      break;
    }

    const vendorPlatform = PLATFORM_TO_VENDOR[platform];
    if (!vendorPlatform) {
      // **The note no longer names a collector, because there is not one.**
      //
      // This used to tell the reader the platform was handled elsewhere, and it
      // was not. `planAiModeCaptures` has tests and no caller, `fetchAiModeAnswer`
      // is reached only through the SDK meter's method reference, and
      // `tryBeginRun` is used solely by this patrol for `llm_mentions`. So the
      // sentence named a sixth kind of thing this codebase has now found six
      // times: **a capability that is built, tested, and never invoked.** The
      // planner's tests pass because they exercise the planner; nothing exercises
      // a runner, because there isn't one.
      //
      // The honest sentence says what is true, which is also what a reader needs:
      // this platform is not collected, and no other job is collecting it either.
      // A reader who believes a monitor has it will stop looking; a reader told
      // "nothing collects this" will know the absence is real.
      //
      // `uncollectedPlatformNote` is shared by the queued branch so both paths
      // cannot drift apart, and the gate asserts the false claim never comes back.
      notes.push(uncollectedPlatformNote(platform));
      continue;
    }

    // ChatGPT mention data is US/en only. Any other market returns an empty set
    // that is indistinguishable from "you are not mentioned", so we ask for the
    // market the vendor actually serves and say so in the run log.
    const locationCode =
      vendorPlatform === "chat_gpt"
        ? CHATGPT_LOCATION_CODE
        : target.locationCode;
    const languageCode =
      vendorPlatform === "chat_gpt"
        ? CHATGPT_LANGUAGE_CODE
        : target.languageCode;
    if (
      vendorPlatform === "chat_gpt" &&
      (locationCode !== target.locationCode ||
        languageCode !== target.languageCode)
    ) {
      notes.push(
        `${platform}: queried at US/en (the only market DataForSEO serves for ChatGPT) instead of ${target.locationCode}/${target.languageCode}.`,
      );
    }

    try {
      const startedAt = new Date().toISOString();
      const requestBody = {
        target: buildLlmTarget({ type: "domain", value: target.domain }),
        platform: vendorPlatform,
        locationCode,
        languageCode,
        limit: Math.min(remaining, 100),
      };
      const data = await client.aiSearch.mentionsSearch(requestBody);

      // The evidence row, written here rather than at the SDK seam because only
      // this layer knows the project, and a table keyed by project with no
      // project is a table nobody can read. It is what makes a stored mention
      // count re-derivable after DataForSEO changes its model — the question a
      // customer asks when the number moves.
      //
      // Deliberately best-effort: a failure to store evidence must not fail a
      // patrol, so the recorder swallows and logs. The gap is stated rather than
      // hidden.
      await recordVendorTask({
        projectId: input.projectId,
        path: "v3/ai_optimization/llm_mentions/search/live",
        requestBody,
        startedAt,
        completedAt: new Date().toISOString(),
        // The mention count is the *headline* of this call's response, and
        // recording it here means a later model change can be told apart from a
        // real movement in visibility.
        responseBody: { answerCount: data.length },
      });

      if (data.length === 0) {
        // A real, reportable outcome rather than an error: the brand simply is
        // not mentioned for these prompts.
        notes.push(`${platform}: no answers found for this target.`);
        continue;
      }

      for (const item of data) {
        if (remaining <= 0) break;
        const row = toAnswerRow({
          answerId: crypto.randomUUID(),
          projectId: input.projectId,
          targetId: target.id,
          promptSetId: input.promptSetId,
          platform,
          locationCode,
          languageCode,
          item,
        });
        if (!row) continue;
        inserts.push(row);
        remaining -= 1;
      }
    } catch (error) {
      // One platform failing must not discard the others' answers, and must be
      // visible in the run log rather than swallowed.
      notes.push(
        `${platform}: failed — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (inserts.length === 0) {
    // Null rather than zero. The run *asked* the vendor and the vendor's
    // question count is unknown, so even a run that came back empty has no
    // denominator — writing 0 here would claim we asked nothing, and 0/0 as a
    // "no visibility" reading is a statement about the world rather than about
    // what we know.
    return {
      snapshotId: null,
      snapshotIds: [],
      answersArchived: 0,
      costUsd,
      promptsAsked,
      notes,
    };
  }

  const snapshot = await GeoService.recordRun({
    projectId: input.projectId,
    promptSetId: input.promptSetId,
    targetId: target.id,
    createdBy: input.createdBy,
    answers: inserts,
    costUsd,
    promptsAsked,
  });

  return {
    snapshotId: snapshot?.id ?? null,
    snapshotIds: snapshot ? [snapshot.id] : [],
    answersArchived: inserts.length,
    costUsd,
    promptsAsked,
    notes,
  };
}

/**
 * Run a patrol for a project's targets.
 *
 * Targets run sequentially on purpose. DataForSEO caps database APIs at 30
 * *simultaneous* requests, and a project with many targets is exactly where an
 * unbounded fan-out would hit that ceiling and start returning limit errors.
 */
async function run(input: PatrolInput): Promise<PatrolRunResult> {
  const allTargets = await GeoSetupRepository.listTargets(input.projectId);
  const targets = input.targetId
    ? allTargets.filter((target) => target.id === input.targetId)
    : allTargets;

  if (targets.length === 0) {
    return {
      snapshotId: null,
      snapshotIds: [],
      answersArchived: 0,
      costUsd: 0,
      // Zero, and this one really is a measured zero: no targets means no
      // questions were put to any model. It is not the same as "we asked and
      // cannot say how many", and a project with no targets should read as
      // *nothing was asked*, not as *the answer is unknown*.
      promptsAsked: 0,
      notes: ["This project has no GEO targets configured."],
    };
  }

  // The billing context is the caller's, not something the patrol invents.
  // Faking one here would bypass the usage-credit check the metered client
  // performs, so a run would spend real money with no budget behind it.
  const client = createDataforseoClient(input.customer);
  const platforms =
    input.platforms ?? (["chat_gpt", "google_ai_overview"] as const);
  const maxAnswers = input.maxAnswers ?? DEFAULT_MAX_ANSWERS;
  const perTarget = Math.max(1, Math.floor(maxAnswers / targets.length));

  const combined: PatrolRunResult = {
    snapshotId: null,
    snapshotIds: [],
    answersArchived: 0,
    costUsd: 0,
    // Starts null, not 0, for the same reason the sum below refuses: a project
    // with no targets has asked nothing, which is a zero, and this counter is
    // about what a *run* asked. It is seeded as "not yet known" and the zero case
    // returns early above.
    promptsAsked: null,
    notes: [],
  };

  for (const target of targets) {
    const result = await runForTarget(
      client,
      input,
      {
        id: target.id,
        domain: target.domain,
        locationCode: target.locationCode,
        languageCode: target.languageCode,
      },
      [...platforms],
      perTarget,
    );
    combined.answersArchived += result.answersArchived;
    combined.costUsd += result.costUsd;
    combined.snapshotId ??= result.snapshotId;
    // Every target's snapshot, so alerting can decide each brand on its own. The
    // `??=` above keeps only the first, which is why a multi-brand project
    // alerted about one brand and stayed silent about the rest.
    combined.snapshotIds.push(...result.snapshotIds);
    /**
     * Sums the denominators, **and refuses to turn a null into a zero.**
     *
     * The obvious one-liner — `combined.promptsAsked += result.promptsAsked` —
     * is wrong in the direction that matters: `null + null` is `0` in JavaScript,
     * so a project whose every target ran the Live path would report a combined
     * denominator of zero, having asked an unknown number of questions zero
     * times. That is the same fabricated denominator this column exists to
     * prevent, arriving through an arithmetic operator rather than a guess.
     *
     * The rule: a run knows its total only if **every** target knew its own.
     * One unknown makes the sum unknown, and a partial total is not a partial
     * answer — it is a wrong one, because a reader cannot tell which kind they
     * have.
     *
     * **The `=== null` test is "this is still the seed", not "this target knew
     * nothing."** The first version read it the second way and left the sum
     * permanently `null`, so a *single-brand* queued project — the most common
     * shape there is — reported `promptsAsked: null` after posting two prompts
     * successfully. The note said "Queued 2 prompts" and the denominator said we
     * did not know, in the same result object. A count of targets is what
     * distinguishes the two cases.
     */
    combined.promptsAsked =
      combined.promptsAsked === null
        ? result.promptsAsked
        : result.promptsAsked === null
          ? null
          : combined.promptsAsked + result.promptsAsked;
    for (const note of result.notes) {
      combined.notes.push(`${target.domain} — ${note}`);
    }
  }

  return combined;
}

export const GeoPatrol = { run } as const;
