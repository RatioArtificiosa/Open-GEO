import { z } from "zod";

// Shared vocabulary for GEO. The server functions, the MCP tools and the UI all
// validate against these, so the wire shape of a request is defined exactly
// once — and the honesty rules are enforced where the data enters, not in each
// caller.

/**
 * The AI platforms we store answers for. Mirrors the schema enum.
 *
 * Not re-exported as a type: the server functions and the repositories each
 * declare the union they need, and `knip` enforces that we do not publish a
 * second copy of this list that could drift from the schema.
 */
export const GEO_PLATFORMS = [
  "chat_gpt",
  "gemini",
  "perplexity",
  "google_ai_overview",
] as const;
const geoPlatformSchema = z.enum(GEO_PLATFORMS);

/**
 * The platforms whose retrieval list DataForSEO returns. Google AI Overviews
 * returns citations but not what it retrieved, so the "retrieved but never
 * cited" gap is a ChatGPT capability. Exposed to clients so a UI can explain an
 * empty gap instead of implying there isn't one.
 */
export const GEO_RETRIEVAL_PLATFORMS: readonly (typeof GEO_PLATFORMS)[number][] =
  ["chat_gpt"];

export const GEO_PROMPT_INTENTS = [
  "informational",
  "commercial",
  "transactional",
  "navigational",
] as const;
const geoPromptIntentSchema = z.enum(GEO_PROMPT_INTENTS);

/** Human labels, so the UI never invents its own wording for a platform. */
export const GEO_PLATFORM_LABELS: Record<
  (typeof GEO_PLATFORMS)[number],
  string
> = {
  chat_gpt: "ChatGPT",
  gemini: "Gemini",
  perplexity: "Perplexity",
  google_ai_overview: "Google AI Overviews",
};

/**
 * A bare host, normalised the same way `GeoService` normalises it.
 *
 * Trimming, lower-casing and stripping a leading `www.` happen HERE rather than
 * only in the service, so a `www.` brand is accepted and folded to one row
 * instead of being rejected or creating a duplicate target. `https://` and any
 * path are still rejected: those are URLs, not domains, and a caller sending one
 * has made a mistake worth surfacing.
 */
const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/^www\./, ""))
  .pipe(
    z
      .string()
      .min(4)
      .max(253)
      .regex(
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
        "Enter a bare domain such as acme.com, without https:// or a path.",
      ),
  );

const locationCodeSchema = z.number().int().positive();
const languageCodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(5)
  .regex(/^[a-z]{2}(-[a-z]{2})?$/i, "Use an ISO language code such as en.");

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export const listGeoTargetsSchema = z.object({});

export const upsertGeoTargetSchema = z.object({
  domain: domainSchema,
  name: z.string().trim().min(1).max(200).optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  locationCode: locationCodeSchema,
  languageCode: languageCodeSchema,
});

export const deleteGeoTargetSchema = z.object({
  targetId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Prompt sets
// ---------------------------------------------------------------------------

const promptSchema = z.object({
  prompt: z.string().trim().min(3).max(700),
  intent: geoPromptIntentSchema.optional(),
});

export const listGeoPromptSetsSchema = z.object({});

export const createGeoPromptSetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  // A set with no prompts cannot be run, so reject it at the boundary rather
  // than letting a patrol discover it later.
  prompts: z.array(promptSchema).min(1).max(500),
});

export const deleteGeoPromptSetSchema = z.object({
  promptSetId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Reading the archive
// ---------------------------------------------------------------------------

export const getGeoVisibilitySchema = z.object({
  targetId: z.string().uuid(),
  /** Omit for every platform. The response is per-platform either way. */
  platforms: z.array(geoPlatformSchema).min(1).max(4).optional(),
});

export const getGeoCitationGapSchema = z.object({
  targetId: z.string().uuid(),
  platform: geoPlatformSchema,
  /** Defaults to the target's own domain. */
  domain: domainSchema.optional(),
  /** ISO timestamp; defaults to the last 30 days. */
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const getGeoAnswerSchema = z.object({
  answerId: z.string().uuid(),
});

export const listGeoAnswerHistorySchema = z.object({
  prompt: z.string().trim().min(1).max(700),
  platform: geoPlatformSchema,
  limit: z.number().int().min(1).max(200).optional(),
});

export const listGeoRunsSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});

export const getGeoRunSchema = z.object({
  snapshotId: z.string().uuid(),
});

export const getGeoShareOfVoiceSchema = z.object({
  snapshotId: z.string().uuid(),
  platform: geoPlatformSchema,
  limit: z.number().int().min(1).max(200).optional(),
});

export const getGeoAiKeywordHistorySchema = z.object({
  keyword: z.string().trim().min(1).max(250),
});

// No `*Input` type aliases here. The schemas are consumed by the server
// functions, which pass `data` straight to the service, so nothing needs to name
// these types yet — and knip is right that an unused export is a lie about the
// API surface. Add them when a caller actually imports one.
