/**
 * Tool justifications for the app submission.
 *
 * Kept in code so the file cannot drift from the server. The 15 tools added by
 * this generator were missing from `chatgpt-app-submission.json` entirely —
 * including all five GEO tools — so a reviewer saw an SEO product and none of
 * the AI-visibility work.
 *
 * Every entry owes **all three** justifications, unconditionally. The schema
 * requires it on every tool, not only on the open-world or destructive ones: a
 * read-only tool still needs a `destructive_justification` saying why it is
 * safe. The text is also not decoration — justifications do not override
 * annotations, so if a tool advertises `readOnlyHint: false` the justification
 * has to be true of the behaviour, not aspirational.
 */

const PRIVATE_STATE =
  "Operates only on private OpenGeo state or private provider data and cannot change publicly visible internet state.";
const NOTHING_DESTRUCTIVE =
  "Does not delete, overwrite, revoke access, send messages, or perform irreversible actions.";

export type ToolJustifications = {
  read_only_justification: string;
  open_world_justification: string;
  destructive_justification: string;
};

/** The tools that existed in the server and were missing from the file. */
export const MISSING_TOOL_JUSTIFICATIONS: Record<string, ToolJustifications> = {
  // --- Share of voice. The `geo-audit` skill instructs agents to call this by
  // name, and before it existed the audit could not start at all.
  compute_share_of_voice: {
    read_only_justification:
      "Compares a brand against up to nine competitors in AI answers and returns a share-of-voice leaderboard over mentions. Returns no search-volume figure, because Google's volume and ChatGPT's modelled demand are different units that must not be added.",
    open_world_justification:
      "Uses a private SEO research provider and cannot publish or modify publicly visible internet state.",
    destructive_justification:
      "May use metered research credits when dry_run is explicitly false, but does not delete, overwrite, revoke access, send, or publish anything.",
  },

  // --- GEO / AI visibility. The headline feature, invisible to a reviewer
  // until these were declared. Every one reads the customer's own archive, so
  // they are genuinely read-only: no credits, no vendor call, no write.
  list_geo_targets: {
    read_only_justification:
      "Only retrieves the AI brands already being monitored in the authenticated OpenGeo project.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification: NOTHING_DESTRUCTIVE,
  },
  get_geo_visibility: {
    read_only_justification:
      "Only reads the archived AI answers already stored for this project. Returns one figure per platform and never a combined total, because the platforms compute demand differently.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification: NOTHING_DESTRUCTIVE,
  },
  get_geo_citation_gap: {
    read_only_justification:
      "Only reads stored answers to find pages a model retrieved and did not cite. Available for ChatGPT only; for Google AI Overviews the response explains that the vendor does not report retrievals rather than returning a confident empty list.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification: NOTHING_DESTRUCTIVE,
  },
  get_geo_top_citations: {
    read_only_justification:
      "Only reads the stored citation archive from the project's most recent monitoring run, per platform. Mention counts are reported per platform and never summed.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification: NOTHING_DESTRUCTIVE,
  },
  get_geo_answer_history: {
    read_only_justification:
      "Only retrieves previously archived answers to one prompt, newest first, so a change between two runs can be compared.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification: NOTHING_DESTRUCTIVE,
  },
  get_geo_runs: {
    read_only_justification:
      "Only lists the monitoring runs that built the project's archive, newest first, and when the last one ran.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification: NOTHING_DESTRUCTIVE,
  },

  // --- Live vendor reads. These spend metered DataForSEO credits on the
  // live path (dry_run: false), so they are not read-only in the
  // annotation sense; the justifications say so rather than claiming a
  // free read. dry_run defaults to true, so the default call spends nothing.
  ai_mode_query: {
    read_only_justification:
      "Fetches the Google AI Mode SERP for one keyword — answer elements, references and a reproducible check URL — for the authenticated project's market and language. Returns one platform's answer and never combines platforms.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification:
      "May use metered DataForSEO credits when dry_run is explicitly false, but does not delete, overwrite, revoke access, send, or publish anything.",
  },
  geo_brand_framing: {
    read_only_justification:
      "Fetches the entity buckets ChatGPT files a monitored domain under — title and category labels with mention counts — and returns a one-sentence positioning diagnosis. ChatGPT-only: the response names that it is one model's view, not a statement about every AI engine.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification:
      "May use metered DataForSEO credits when dry_run is explicitly false, but does not delete, overwrite, revoke access, send, or publish anything.",
  },
  geo_prompt_run: {
    read_only_justification:
      "Sends one prompt to one AI platform's model and returns the answer with its citations, for testing how a model answers a question about a brand before it is added to a prompt set. One platform per call; results are never combined across platforms.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification:
      "May use metered DataForSEO credits (a base fee plus the model's own token cost) when dry_run is explicitly false, but does not delete, overwrite, revoke access, send, or publish anything.",
  },
  ai_keyword_volume: {
    read_only_justification:
      "Returns DataForSEO's AI-demand figure for up to 1000 keywords in one call, optionally with a 12-month series. The response states that this AI volume is a People-Also-Ask-derived model and is not comparable with Google search volume or with the same-named field from other AI tools.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification:
      "May use metered DataForSEO credits on dry_run: false, billed per keyword. Does not delete, overwrite, revoke access, send, or publish anything.",
  },
  forecast_traffic: {
    read_only_justification:
      "Reads the organic-traffic series already stored for a domain in the authenticated project and projects 13 weeks from it with a widening band. It makes no live vendor call and stores nothing. The response names the ETV formula the series was built on and flags a window that crosses the formula change as crossing it.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification: NOTHING_DESTRUCTIVE,
  },
  serp_ask: {
    read_only_justification:
      "Posts a Google SERP for one keyword and returns one model's summary of it with the links that summary cited. The response states that the summary is a single model's reading rather than a fact about the web, that DataForSEO does not identify which model produced it, and whether the model also reasoned over the answer box, knowledge graph and featured snippet.",
    open_world_justification:
      "Sends a search term and a question to a private SEO research provider. The question concerns the caller's own research topic and is not published to any public service.",
    destructive_justification:
      "May use metered DataForSEO credits on dry_run: false, for both the SERP crawl and the summary, and may additionally crawl page content when fetch_content is set. Does not delete, overwrite, revoke access, send, or publish anything.",
  },
  report_publish: {
    read_only_justification:
      "Mints or revokes a public link to one report in the authenticated project. It changes nothing else and reads nothing the caller cannot already read. Publishing is only performed when the caller passes publish: true together with dry_run: false, and the default dry run only describes the exposure.",
    open_world_justification:
      "**Publishing places one customer's report on the public internet at an unauthenticated URL that anyone holding the link can read.** Revoking restricts access again and is safe to call at any time. Sharing is refused outright on self-hosted deployments.",
    destructive_justification:
      "Publishing creates a bearer credential in the URL and cannot be undone by anyone who has already copied the link; only revoking the token limits further access. It does not delete or overwrite the stored report.",
  },
  compare_ai_web_sentiment: {
    read_only_justification:
      "Reports how a search provider's index classified pages citing a keyword, alongside what AI engines say when asked about it, and returns the AI answer as prose. It stores nothing and reads nothing the caller could not read elsewhere.",
    open_world_justification:
      "Sends a keyword and a generated question to a private SEO research provider. The keyword is the caller's own research topic and is not published to any public service.",
    destructive_justification:
      "May use metered DataForSEO credits on dry_run: false, for up to three provider calls. Does not delete, overwrite, revoke access, send, or publish anything. The response deliberately contains no combined sentiment figure, because the two sources are not measured in the same units.",
  },

  // --- Saved keywords. Removing a keyword deletes a stored record, so this is
  // destructive, and it says which project it affects.
  remove_saved_keywords: {
    read_only_justification:
      "Removes selected keyword IDs from the saved list in the user's own project.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification:
      "Deletes the selected saved-keyword records and their tag associations in the user's project. Reversible only by re-running keyword research.",
  },

  // --- Reports and templates. Save creates or overwrites; delete destroys.
  save_report: {
    read_only_justification:
      "Creates or updates a private report record in the user's project and does not share or publish it.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification:
      "Overwrites the stored report content and title when saving with an existing report ID. Nothing is published or sent.",
  },
  list_reports: {
    read_only_justification:
      "Only retrieves the reports already stored in the user's project.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification: NOTHING_DESTRUCTIVE,
  },
  get_report: {
    read_only_justification:
      "Only retrieves one stored report and its sections by ID.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification: NOTHING_DESTRUCTIVE,
  },
  delete_report: {
    read_only_justification:
      "Deletes the report with the supplied ID from the user's own project.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification:
      "Permanently removes the stored report and its sections, including any share token that would otherwise keep a public link alive.",
  },
  list_report_templates: {
    read_only_justification:
      "Only retrieves the report templates already stored in the user's project.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification: NOTHING_DESTRUCTIVE,
  },
  save_report_template: {
    read_only_justification:
      "Creates or updates a private report template in the user's project.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification:
      "Overwrites the stored template's name, description and section layout when saving with an existing template ID.",
  },
  delete_report_template: {
    read_only_justification:
      "Deletes the report template with the supplied ID from the user's own project.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification:
      "Permanently removes the stored template. Reports already generated from it are not affected.",
  },

  // --- Site audits. Delete removes a stored audit and its pages and issues.
  list_site_audits: {
    read_only_justification:
      "Only retrieves the site audits already started in the user's project.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification: NOTHING_DESTRUCTIVE,
  },
  delete_site_audit: {
    read_only_justification:
      "Deletes the site audit with the supplied ID from the user's own project.",
    open_world_justification: PRIVATE_STATE,
    destructive_justification:
      "Permanently removes the stored audit record together with its crawled pages and issues.",
  },
};
