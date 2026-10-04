export type CreditFeature =
  | "keyword_research"
  | "domain_overview"
  | "backlinks"
  | "site_audit"
  | "rank_tracking"
  | "ai_citations"
  | "ai_demand"
  | "ai_prompt_responses"
  | "local_seo"
  | "agent";

const CREDIT_FEATURE_LABELS: Record<string, string> = {
  keyword_research: "Keyword Research",
  domain_overview: "Domain Overview",
  backlinks: "Backlinks",
  site_audit: "Site Audit",
  rank_tracking: "Rank Tracking",
  ai_citations: "AI Citations",
  ai_demand: "AI Demand",
  ai_prompt_responses: "AI Prompt Responses",
  ai_search: "AI Search",
  local_seo: "Local SEO",
  // The onboarding chat is gone, but historical usage events still carry this
  // key — keep the label so old billing breakdowns don't render "Other".
  onboarding: "Onboarding",
  agent: "SAM Agent",
};

/**
 * Maps a DataForSEO API response path (e.g. ["v3", "dataforseo_labs", "google", "related_keywords", "live"])
 * to a product feature for analytics. path[1] is the API module; for dataforseo_labs,
 * path[3] distinguishes keyword vs domain endpoints.
 */
export function mapDataforseoPathToCreditFeature(
  path: readonly string[],
): CreditFeature {
  const normalizedPath = path[0] === "v3" ? path : ["v3", ...path];
  const module = normalizedPath[1];

  switch (module) {
    case "on_page":
      return "site_audit";
    case "backlinks":
      return "backlinks";
    case "serp":
      return normalizedPath[2] === "google" &&
        ["maps", "local_finder"].includes(normalizedPath[3])
        ? "local_seo"
        : "keyword_research";
    case "ai_optimization":
      return mapAiOptimization(normalizedPath[2]);
    // Content Analysis is citation data about a keyword: which domains cite it,
    // and how the citing pages were classified. `ai_citations` because that is
    // what a customer reading the breakdown is looking at — **not** `backlinks`,
    // which would render as "Backlinks" next to a call that never touched a
    // backlink, and **not** the `default` of `site_audit`, which is what this
    // fell through to before.
    case "content_analysis":
      return "ai_citations";
    case "business_data":
      return "local_seo";
    case "keywords_data":
      return "keyword_research";
    case "dataforseo_labs": {
      const endpoint = normalizedPath[3] ?? "";
      if (
        endpoint.startsWith("domain_") ||
        endpoint === "ranked_keywords" ||
        endpoint === "relevant_pages"
      ) {
        return "domain_overview";
      }
      return "keyword_research";
    }
    default:
      return "site_audit";
  }
}

/**
 * The `ai_optimization` module holds three unrelated products that look alike in
 * a path, and the old rule — "`llm_mentions` or it is a prompt response" —
 * quietly mis-billed two of them.
 *
 * | path[2]                  | what it actually is                          | feature              |
 * |--------------------------|---------------------------------------------|----------------------|
 * | `llm_mentions`           | brand/keyword mention and citation lookups   | `ai_citations`       |
 * | `ai_keyword_data`        | AI *demand* for a topic — no model is called | `ai_demand`          |
 * | anything else            | `/llm_responses` — an actual model call      | `ai_prompt_responses`|
 *
 * **`ai_keyword_data` was being billed as prompt responses.** It is not one: it
 * is a statistical dataset derived from People-Also-Ask questions, and it calls
 * no model at all. The cost is roughly $0.06 per 1,000 keywords against ~$0.002
 * per prompt, so the breakdown overstated prompt spend by orders of magnitude and
 * a customer reading it would conclude we were spending on model calls we never
 * made. Worse, it is the *feature the free tools are built on* (CL-137/138), so
 * the distortion grows with exactly the traffic the product is trying to attract.
 *
 * The lesson is the shape of the old rule, not the missing case: a two-branch
 * `if` over a module that has since grown a third branch will keep being wrong
 * as the module grows. The table above and the test that reads it are what stop
 * the next addition from being a silent mis-billing.
 *
 * A fourth case — `locations_and_languages` — is a free metadata lookup shared
 * by all three. It is billed as `ai_demand` because that is what it is fetched
 * *for*; the alternative is inventing a `metadata` feature that would appear in
 * customer breakdowns as a line nobody can act on.
 */
function mapAiOptimization(path2: string | undefined): CreditFeature {
  switch (path2) {
    case "llm_mentions":
      return "ai_citations";
    case "ai_keyword_data":
    case "locations_and_languages":
      return "ai_demand";
    default:
      return "ai_prompt_responses";
  }
}

export function creditFeatureLabel(key: string) {
  return CREDIT_FEATURE_LABELS[key] ?? "Other";
}
