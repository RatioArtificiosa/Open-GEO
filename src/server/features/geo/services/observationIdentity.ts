import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { geoTargets } from "@/db/schema";

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
 *
 * ## What used to be here, and why it moved
 *
 * `observationKey` sat in this file, which meant the *identity* of an observation
 * and the *lookup* of its brand shipped together — and therefore with `@/db`
 * attached. `alertDecision` needs the key and has no business touching a
 * connection, so importing it from here made `alertDecision.test.ts` fail to load
 * under vitest's `node` environment (`Cannot find package 'cloudflare:workers'`).
 *
 * The key now lives in `observationKey.ts`, which imports nothing but a pure URL
 * helper. **The split is by dependency, not by size**: one function needs a
 * string, the other needs a connection, and anything that imports one should not
 * inherit the cost of the other.
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
