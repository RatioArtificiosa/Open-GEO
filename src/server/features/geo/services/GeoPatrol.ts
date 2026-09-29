import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import {
  buildLlmTarget,
  CHATGPT_LANGUAGE_CODE,
  CHATGPT_LOCATION_CODE,
  type LlmPlatform,
} from "@/server/lib/dataforseo/shared";
import { GeoService } from "@/server/features/geo/services/GeoService";
import { GeoSetupRepository } from "@/server/features/geo/repositories/GeoSetupRepository";
import type { GeoAnswerInsert } from "@/server/features/geo/repositories/GeoAnswerRepository";
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
  answersArchived: number;
  /** Vendor cost in USD, summed from the task costs actually returned. */
  costUsd: number;
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
};

const DEFAULT_MAX_ANSWERS = 500;

/** llm_mentions only serves these two platforms. */
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
    // ChatGPT is the only platform where the vendor reports a retrieval list.
    // Elsewhere we cannot distinguish retrieved from cited, so we store
    // citations only — never a retrieval we did not observe.
    retrievals:
      input.platform === "chat_gpt"
        ? citations.map((c) => ({ url: c.url, domain: c.domain, rank: c.rank }))
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

  for (const platform of platforms) {
    if (remaining <= 0) {
      notes.push(
        `Stopped at the ${budget}-answer cap; ${platform} and later platforms were not queried.`,
      );
      break;
    }

    const vendorPlatform = PLATFORM_TO_VENDOR[platform];
    if (!vendorPlatform) {
      notes.push(
        `${platform} is not served by llm_mentions (ChatGPT and Google only); it is collected by the AI Mode monitor.`,
      );
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
      const data = await client.aiSearch.mentionsSearch({
        target: buildLlmTarget({ type: "domain", value: target.domain }),
        platform: vendorPlatform,
        locationCode,
        languageCode,
        limit: Math.min(remaining, 100),
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
    return { snapshotId: null, answersArchived: 0, costUsd, notes };
  }

  const snapshot = await GeoService.recordRun({
    projectId: input.projectId,
    promptSetId: input.promptSetId,
    targetId: target.id,
    createdBy: input.createdBy,
    answers: inserts,
    costUsd,
  });

  return {
    snapshotId: snapshot?.id ?? null,
    answersArchived: inserts.length,
    costUsd,
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
      answersArchived: 0,
      costUsd: 0,
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
    answersArchived: 0,
    costUsd: 0,
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
    for (const note of result.notes) {
      combined.notes.push(`${target.domain} — ${note}`);
    }
  }

  return combined;
}

export const GeoPatrol = { run } as const;
