import { DFS_DOMAIN } from "./dataforseo-pricing";

/**
 * Tech-lead-list cost, in one place (CL-408).
 *
 * A list costs one WHOIS read plus one technologies read per candidate
 * examined. Three surfaces quote it — the credit-gate estimators, the MCP
 * dry run, and the Lead Lists button — so the arithmetic lives here rather
 * than in each caller: a price quoted by hand in three places is three
 * prices, and they come apart silently.
 */

/** Mirrors `limit: input.limit ?? 10` in fetchDomainTechnologies. */
export const TECH_LEAD_TECH_ROWS = 10;

/** One technologies read, as the credit gate prices it. */
function estimateTechCandidateUsd(): number {
  return (
    DFS_DOMAIN.technologies.perRequest +
    DFS_DOMAIN.technologies.perUnit * TECH_LEAD_TECH_ROWS
  );
}

/** The whole list: WHOIS plus one technologies read per candidate. */
export function estimateTechLeadListUsd(maxCandidates: number): number {
  return (
    DFS_DOMAIN.whois.perRequest +
    DFS_DOMAIN.whois.perUnit * maxCandidates +
    maxCandidates * estimateTechCandidateUsd()
  );
}
