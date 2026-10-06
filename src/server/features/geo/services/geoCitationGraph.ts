/**
 * The earn-the-citation list, assembled from the archive.
 *
 * **This is the inverse of a DR tool, and that is the whole product claim.** The
 * proposal's finding is that AI engines cite low-authority long-tail domains — it
 * names two it saw in the *documented vendor response*, `carinterior.alibaba.com`
 * and `everything.explained.today`, alongside reddit and Edmunds. Ranking those by
 * authority would put every domain the models actually use at the bottom, which is
 * why a "ranked by DR" list is the wrong product.
 *
 * ## The three things this must not do
 *
 * 1. **Invent a page count.** `listCitationDomains` returns a `mentions` count per
 *    domain and nothing else. `pages` is passed as 0 rather than guessed, because a
 *    fabricated number is one a reader could act on and cannot be true.
 * 2. **Claim a backlink count it does not have.** `backlinksToUs` is `null` — no
 *    data — never 0. "We have never looked" and "nothing links there" are different
 *    facts, and only the second supports a claim that there is no path. This is the
 *    distinction `citationGraph` is built around.
 * 3. **Read one platform and call it the picture.** A domain cited by ChatGPT and
 *    not by Google is still a domain to reach, so the rows are summed across every
 *    platform.
 *
 * Archive reads only, so it costs nothing.
 */
import { AppError } from "@/server/lib/errors";
import { GeoRunRepository } from "@/server/features/geo/repositories/GeoRunRepository";
import { GeoSetupRepository } from "@/server/features/geo/repositories/GeoSetupRepository";
import { buildCitationGraph } from "@/server/features/geo/services/citationGraph";
import { buildCoCitations } from "@/server/features/geo/services/citationCoCitations";
import { hostOf } from "@/server/features/geo/services/urlIdentity";
import { GEO_PLATFORMS } from "@/server/features/geo/repositories/GeoSetupRepository";

/** The four answer platforms, kept in one place so a reader can see the union. */
const ALL_PLATFORMS = GEO_PLATFORMS;

export async function getCitationGraph(input: {
  projectId: string;
  domain: string;
  limit?: number;
}) {
  const target = await GeoSetupRepository.getTargetByDomain(
    input.projectId,
    normaliseDomain(input.domain),
  );
  if (!target) {
    throw new AppError(
      "NOT_FOUND",
      `${input.domain} is not a monitored target in this project, so it has no citation graph.`,
    );
  }

  const [latest] = await GeoRunRepository.listSnapshots(input.projectId, 1);
  if (!latest) {
    // No run yet. `buildCitationGraph` handles an empty set honestly — the insight
    // is null rather than a finding with nothing behind it — and this keeps the
    // return type a graph either way, so a caller never has to branch.
    return buildCitationGraph({ ownDomain: target.domain, domains: [] });
  }

  const perPlatform = await Promise.all(
    ALL_PLATFORMS.map((platform) =>
      GeoRunRepository.listCitationDomains(
        input.projectId,
        latest.id,
        platform,
        input.limit ?? 100,
      ),
    ),
  );

  const merged = new Map<string, { domain: string; citations: number }>();
  for (const rows of perPlatform) {
    for (const row of rows) {
      const domain = hostOf(row.domain ?? null);
      if (domain === null) continue;
      const existing = merged.get(domain);
      merged.set(domain, {
        domain,
        citations: (existing?.citations ?? 0) + row.mentions,
      });
    }
  }

  return buildCitationGraph({
    ownDomain: target.domain,
    domains: [...merged.values()].map((row) => ({
      ...row,
      // See the docstring: a placeholder rather than a guess, and an explicit
      // "no data" rather than a measured zero.
      pages: 0,
      backlinksToUs: null,
    })),
    // **The edges come from the answers, not from the rollups.** The per-platform
    // rows above have already collapsed to a count per domain, which is exactly
    // the information an edge needs to keep — so the pairs are read separately,
    // scoped to the same run, and capped by `buildCoCitations` because §14.4's
    // list comes first and a graph of everything is a hairball.
    coCitations: buildCoCitations(
      await GeoRunRepository.listSnapshotCitations(input.projectId, latest.id),
    ),
  });
}

/** Normalise a brand to a bare lowercase host, matching the target lookup. */
function normaliseDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}
