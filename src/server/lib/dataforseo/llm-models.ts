import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import { dataforseoGet } from "@/server/lib/dataforseo/core";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";

/**
 * The LLM model catalog, fetched at runtime.
 *
 * Why this module exists: the fork hardcoded an allow-list of `model_name`
 * values ("verified 2026-06-30"). DataForSEO *bills a task that fails with
 * `Invalid Field: 'model_name'`*, so a stale list silently converts into
 * wasted money the moment the vendor adds a model. Their own docs expose the
 * live catalog per platform, so we read that instead and cache it.
 *
 * The hardcoded list is retained only as a last-resort fallback when the
 * catalog endpoint is unreachable (e.g. sandbox hiccup) — never as the primary
 * source of truth.
 */

export const LLM_MODEL_SLUGS = [
  "chat_gpt",
  "claude",
  "gemini",
  "perplexity",
] as const;
export type LlmModelSlug = (typeof LLM_MODEL_SLUGS)[number];

type LlmModel = {
  modelName: string;
  /** Supports extended reasoning/thinking. */
  reasoning: boolean;
  /** `web_search` may be set on this model. */
  webSearchSupported: boolean;
  /** Standard (POST/GET) retrieval is available; false = Live only. */
  taskPostSupported: boolean;
};

const modelSchema = z
  .object({
    model_name: z.string(),
    reasoning: z.boolean().nullish(),
    web_search_supported: z.boolean().nullish(),
    task_post_supported: z.boolean().nullish(),
  })
  .passthrough();

const modelsResponseSchema = z
  .object({
    tasks: z
      .array(
        z
          .object({
            result: z.array(z.unknown()).nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

/**
 * Last-resort fallback catalog. Documented as a snapshot (2026-06-30) precisely
 * so nobody treats it as current — `refreshLlmModelCatalog` replaces it.
 */
const FALLBACK_MODELS: Record<LlmModelSlug, readonly string[]> = {
  chat_gpt: ["gpt-5"],
  claude: ["claude-sonnet-4-5", "claude-sonnet-4-6"],
  gemini: ["gemini-2.5-pro"],
  perplexity: ["sonar-reasoning-pro", "sonar-pro", "sonar"],
};

type CacheEntry = { models: LlmModel[]; fetchedAt: number };

const cache = new Map<LlmModelSlug, CacheEntry>();

async function catalogTtlHours(): Promise<number> {
  const raw = await getOptionalEnvValue("GEO_LLM_MODEL_CATALOG_TTL_HOURS");
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
}

function toModel(raw: z.infer<typeof modelSchema>): LlmModel {
  return {
    modelName: raw.model_name,
    reasoning: raw.reasoning === true,
    webSearchSupported: raw.web_search_supported === true,
    taskPostSupported: raw.task_post_supported === true,
  };
}

/**
 * Return the live catalog for a platform, fetching (and caching) on demand.
 * Falls back to the documented snapshot if the endpoint fails, so a catalog
 * outage degrades rather than blocks.
 */
export async function getLlmModels(slug: LlmModelSlug): Promise<LlmModel[]> {
  const ttlMs = (await catalogTtlHours()) * 60 * 60 * 1000;
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.fetchedAt < ttlMs) return hit.models;

  try {
    const response = await dataforseoGet(
      `/v3/ai_optimization/${slug}/llm_responses/models`,
    );
    const parsed = modelsResponseSchema.safeParse(response);
    if (!parsed.success) throw new Error("unexpected models envelope");

    const rawResults = parsed.data.tasks?.[0]?.result ?? [];
    const models: LlmModel[] = [];
    for (const entry of rawResults) {
      const parsedEntry = modelSchema.safeParse(entry);
      if (parsedEntry.success) models.push(toModel(parsedEntry.data));
    }

    if (models.length === 0) throw new Error("empty models catalog");

    cache.set(slug, { models, fetchedAt: Date.now() });
    return models;
  } catch {
    return FALLBACK_MODELS[slug].map((modelName) => ({
      modelName,
      reasoning: false,
      webSearchSupported: true,
      taskPostSupported: true,
    }));
  }
}

/** True when the platform currently offers this exact model name. */
export async function isLlmModelSupported(
  slug: LlmModelSlug,
  modelName: string,
): Promise<boolean> {
  const models = await getLlmModels(slug);
  return models.some((m) => m.modelName === modelName);
}

/**
 * Resolve a model, tolerating a basic alias. DataForSEO resolves e.g.
 * `claude-sonnet-4-5` to its latest dated version, so callers may pass the
 * short name.
 */
export async function resolveLlmModel(
  slug: LlmModelSlug,
  requested: string,
): Promise<LlmModel> {
  const models = await getLlmModels(slug);
  const exact = models.find((m) => m.modelName === requested);
  if (exact) return exact;
  const alias = models.find((m) => m.modelName.startsWith(requested));
  if (alias) return alias;
  throw new AppError(
    "VALIDATION_ERROR",
    `Unsupported DataForSEO model_name "${requested}" for ${slug}. ` +
      `Available: ${models.map((m) => m.modelName).join(", ") || "none reported"}`,
  );
}

/** Whether a model accepts `web_search`, so we never send a rejected field. */
export async function supportsWebSearch(
  slug: LlmModelSlug,
  modelName: string,
): Promise<boolean> {
  try {
    const model = await resolveLlmModel(slug, modelName);
    return model.webSearchSupported;
  } catch {
    return true;
  }
}

/** Test seam. */
export function resetLlmModelCatalogCache(): void {
  cache.clear();
}
