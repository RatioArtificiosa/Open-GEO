import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { geoTargets } from "@/db/schema";
import { normaliseUrlForJoin } from "./urlIdentity";

/**
 * The identity of an observation: which brand, on which platform, asked which
 * question.
 *
 * ## Why the brand is part of it
 *
 * The patrol asks **every target in the project the same prompt set**, so two
 * brands produce two answers for one prompt on one platform. Keying on
 * `platform|prompt` alone made those collide: the second brand's row was
 * discarded as a duplicate, and the survivor was compared against whichever
 * brand the previous run happened to keep — so a change in one brand could be
 * reported as a change in the other. A "you lost this mention" alert is something
 * a customer acts on, and acting on the wrong brand is worse than no alert.
 *
 * This lives apart from the reader because **both** sides of a comparison need it:
 * the reader keys what it reads, and `alertDecision` keys what it diffs. Two
 * copies of an identity is how they come to disagree, and the disagreement is
 * silent — a diff that matches the wrong row produces a confident wrong answer.
 *
 * A `null` domain stays distinguishable in the key rather than collapsing to a
 * placeholder: two observations with no domain genuinely cannot be attributed, and
 * stringifying them alike would recreate the collision for exactly the rows that
 * cannot be resolved.
 */
export function observationKey(input: {
  domain: string | null;
  platform: string;
  prompt: string;
}): string {
  const normalised = normaliseUrlForJoin(input.prompt) ?? input.prompt.trim();
  return `${input.domain ?? ""}|${input.platform}|${normalised}`;
}

/**
 * The domains for a set of targets, in one query.
 *
 * Scoped by `projectId` **and** by the id set, so a target id belonging to
 * another project cannot be resolved even if one reaches here — the same
 * cross-project guard the forecast reader needs, and the reason this takes the
 * project rather than trusting the caller's.
 *
 * An empty set short-circuits before the query rather than issuing a pointless
 * `IN ()`.
 */
export async function loadDomainsForTargets(
  projectId: string,
  targetIds: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (targetIds.size === 0) return out;
  const targets = await db
    .select({ id: geoTargets.id, domain: geoTargets.domain })
    .from(geoTargets)
    .where(
      and(
        eq(geoTargets.projectId, projectId),
        inArray(geoTargets.id, [...targetIds]),
      ),
    );
  for (const t of targets) out.set(t.id, t.domain);
  return out;
}
