import { z } from "zod";
import { GeoSetupRepository } from "@/server/features/geo/repositories/GeoSetupRepository";
import { GEO_PLATFORMS } from "@/types/schemas/geo";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";

/**
 * Shared vocabulary for the GEO MCP tools.
 *
 * Two rules live here rather than in each tool, because getting either wrong is
 * silent rather than loud:
 *
 * 1. **Per-platform numbers stay separate.** Google AI Overviews and ChatGPT
 *    compute `ai_search_volume` differently — Google's is real search volume,
 *    ChatGPT's is People-Also-Ask modelled. We measured 12,621,380 against
 *    63,850 for one keyword. A single combined number would look authoritative
 *    and mean nothing.
 * 2. **A missing capability is stated, not implied.** Google AI Overviews returns
 *    citations but not retrievals, so there is no citation gap for it, and the
 *    response says so rather than returning a confident empty list.
 */

export const geoPlatformSchema = z
  .enum(GEO_PLATFORMS)
  .describe(
    "AI platform to report on. Each computes demand differently, so results are never combined across platforms. Omit to get all four.",
  );

export const geoDomainSchema = z
  .string()
  .min(1)
  .max(2048)
  .describe("The brand's domain, e.g. 'acme.com'. Must already be monitored.");

/** The same normalisation the repositories use, so a pasted URL still matches. */
function normaliseGeoDomain(input: string): string {
  return (
    input
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0] ?? ""
  );
}

/**
 * Every GEO tool can answer with meta and no structured content — for example
 * when asked about a domain that is not monitored, where the correct reply is a
 * sentence rather than a result set.
 *
 * `meta-only-response.test.ts` enforces that an output schema accepts that
 * shape. Merging these two fields into every GEO output schema is what makes an
 * unmonitored domain a one-line explanation instead of an MCP validation error
 * the caller cannot interpret.
 */
export const metaOnlyOutputFields = {
  domain: z.string().optional(),
  platform: z.string().optional(),
  ...optionalMetaOutputSchema,
} as const;

/**
 * Find a monitored target by any spelling the caller might paste.
 *
 * Returns null rather than throwing: a tool asked about an unmonitored domain
 * should say so in one sentence, not surface a NOT_FOUND stack.
 */
export async function findGeoTarget(
  projectId: string,
  domain: string,
): Promise<{ id: string; domain: string; name: string } | null> {
  const wanted = normaliseGeoDomain(domain);
  const targets = await GeoSetupRepository.listTargets(projectId);
  return (
    targets.find((row) => row.domain === wanted || row.domain === domain) ??
    null
  );
}
