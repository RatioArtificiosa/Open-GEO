/**
 * The monthly AI keyword demand capture, driven by the cron.
 *
 * ## Why this file exists at all
 *
 * Three links of a chain were already here and the fourth was not:
 *
 * | link | state |
 * |---|---|
 * | `fetchAiKeywordVolume` — the vendor client | exists, tested |
 * | `ai_keyword_metrics` — the table | exists, migrated, keyed project+keyword+market+month |
 * | `upsertAiKeywordMetrics` — the write | exists, tested, **called by nothing** |
 * | `getGeoAiKeywordHistory` — the read | exists, unmounted |
 *
 * So the table was **never written** and the endpoint returned an empty list
 * forever. That makes the missing reader a misleading place to start: a screen for
 * `getGeoAiKeywordHistory` would have been a screen for nothing, drawing an empty
 * chart and looking like a working feature with no data yet.
 *
 * `ai-keywords.ts` says so itself, and names the gap rather than hiding it:
 * *"nothing outside this file consumes these yet… Export them when a caller needs
 * to name the shape."* The client was built for a caller that never arrived. This
 * is that caller.
 *
 * ## Why it is a separate handler rather than part of the patrol
 *
 * **It is a different question and a different price.** `geo_ai_mentions_*` measures
 * whether a brand was *named*; `ai_keyword_metrics` measures whether the *prompt had
 * demand to be won*. Mixing them into one run would mean one line per keyword
 * answering two unrelated things, and the reader could no longer tell which
 * measurement a number came from.
 *
 * ## Why it is safe to leave switched on
 *
 * 1. **Monthly data, monthly call.** The vendor returns
 *    `ai_monthly_searches` — a whole history in one request. Capturing daily would
 *    re-fetch the same months and pay the same price to store identical rows.
 * 2. **The market comes from the target**, never from the caller: a US-only figure
 *    attached to a London project is a different measurement wearing the same label.
 * 3. **Batched and capped.** One request covers up to 1000 keywords, so the cost is
 *    per *call* rather than per keyword — and the batch limit is the vendor's own,
 *    because exceeding it is a billed rejection.
 * 4. **Never retried on the same tick.** A billed failure is recorded and dropped,
 *    exactly as `aiModeMonitor` does, because a retry after an unknown-outcome
 *    request is how a budget disappears without a trace.
 */
import { eq } from "drizzle-orm";
import type { BudgetedCaptureReport } from "@/server/features/geo/services/captureReport";
import { db } from "@/db";
import { geoPrompts, geoPromptSets, geoTargets } from "@/db/schema";
import { fetchAiKeywordVolume } from "@/server/lib/dataforseo/ai-keywords";
import { GeoRunRepository } from "@/server/features/geo/repositories/GeoRunRepository";

/**
 * The vendor's own batch ceiling, not a number chosen here.
 *
 * `validateAiKeywordBatch` clamps to this, so exceeding it is a **billed rejection**
 * rather than a silent truncation — which is why this constant exists to be *read*
 * by that guard rather than duplicated by a caller.
 */
const VENDOR_MAX_KEYWORDS = 1000;

/**
 * One keyword-demand call, in USD.
 *
 * **A placeholder, deliberately, and this is the honest state of it.** The price
 * book has no verified figure for
 * `/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live` — the live
 * verification is blocked on the account being funded. `aiModeMonitor`'s $0.004 was
 * *verified against the vendor's own example response*; quoting a similar-looking
 * number here would put an unverified figure in the one place that bounds spending,
 * which is the failure this repository has repeatedly declined to accept.
 *
 * Until it is verified against a real invoice, the conservative reading is the
 * **highest plausible** one: `ai_keyword_data` is priced per task, and the sibling
 * `llm_mentions` family is $0.0006/task. Over-estimating here makes the planner
 * drop keywords it could have afforded; under-estimating makes the bill surprising.
 * **Refusing to run is worse than either**, so the conservative error is the right
 * direction — and the note says which direction it errs.
 */
const AI_KEYWORD_UNIT_COST_USD = 0.002;

/** The night's ceiling, in USD. Same reasoning as the AI Mode cap: a constant, not an invented setting. */
/**
 * A **placeholder pending the pricing plan**, and named as one.
 *
 * `$5` buys 2500 keyword calls, and the unit price above is **itself an unverified
 * placeholder** — so the product of two guesses is not a budget anyone chose.
 *
 * **The honest default would be `null`, bounded instead by the project's own tracked
 * keywords.** `scheduledGeoPatrol.ts` states the product's position in the same words I
 * originally used here — *"the product has no per-project spend setting, and inventing a
 * ceiling would refuse runs on a number nobody chose"* — and then passes `budgetUsd:
 * null`. I quoted that reasoning and wrote a number into it anyway, citing a sibling that
 * had `$0.1`.
 *
 * It is a number rather than `null` so the capture is safe to switch on before the pricing
 * decision is made, and **the report names what the ceiling dropped** — so a wrong
 * placeholder costs coverage loudly rather than silently, which is the difference that
 * makes it acceptable to ship.
 */
const AI_KEYWORD_NIGHTLY_BUDGET_USD = 5;

/**
 * Projects with keywords worth asking about.
 *
 * **The prompt text is the keyword.** A project that tracks "best crm software" is
 * asking about that phrase's demand; there is no separate keyword list to maintain
 * and therefore no way for a keyword to be captured that nobody is actually asking
 * about. The set is the source of the demand, which is the cheapest honest choice.
 */
async function projectsWatchingKeywords(): Promise<
  Array<{
    projectId: string;
    keywords: string[];
    locationCode: number;
    languageCode: string;
  }>
> {
  const rows = await db
    .select({
      projectId: geoTargets.projectId,
      // `geo_prompts.prompt`, verbatim. **Not normalised here** —
      // `ai-keywords.ts` normalises on both the request and the response precisely
      // so the vendor's returned string is a safe join key, and exporting
      // `normaliseAiKeyword` is for a caller that needs the same rule. Normalising
      // here as well would be a second copy of that rule to keep in step.
      keyword: geoPrompts.prompt,
      locationCode: geoTargets.locationCode,
      languageCode: geoTargets.languageCode,
    })
    .from(geoPromptSets)
    .innerJoin(geoTargets, eq(geoTargets.projectId, geoPromptSets.projectId))
    .innerJoin(geoPrompts, eq(geoPrompts.promptSetId, geoPromptSets.id))
    .groupBy(
      geoTargets.projectId,
      geoPrompts.prompt,
      geoTargets.locationCode,
      geoTargets.languageCode,
    );

  const byProject = new Map<
    string,
    {
      projectId: string;
      keywords: Set<string>;
      locationCode: number;
      languageCode: string;
    }
  >();
  for (const row of rows) {
    const entry = byProject.get(row.projectId) ?? {
      projectId: row.projectId,
      keywords: new Set<string>(),
      locationCode: row.locationCode,
      languageCode: row.languageCode,
    };
    entry.keywords.add(row.keyword);
    byProject.set(row.projectId, entry);
  }

  return [...byProject.values()].map((entry) => ({
    projectId: entry.projectId,
    keywords: [...entry.keywords],
    locationCode: entry.locationCode,
    languageCode: entry.languageCode,
  }));
}

/**
 * One keyword's monthly readings, oldest first.
 *
 * **A month of `0` is a reading, and `null` is an absence — the pair this feature
 * exists to keep apart.** The vendor's own schema comment says a month may
 * legitimately be 0 ("the keyword had no recorded AI demand then"), and the
 * repository refuses to interpolate a missing month to zero because that invents a
 * dip that never happened. Collapsing the two here would undo both defences at
 * once, so the value passes through exactly as the vendor sent it.
 */
function toMonthlyRows(input: {
  projectId: string;
  keyword: string;
  locationCode: number;
  languageCode: string;
  item: {
    ai_monthly_searches?: Array<{
      year: number;
      month: number;
      ai_search_volume?: number | null;
    }> | null;
  };
  now: Date;
}): Array<{
  keyword: string;
  projectId: string;
  locationCode: number;
  languageCode: string;
  aiSearchVolume: number | null;
  month: string;
  capturedAt: string;
}> {
  const rows: Array<{
    keyword: string;
    projectId: string;
    locationCode: number;
    languageCode: string;
    aiSearchVolume: number | null;
    month: string;
    capturedAt: string;
  }> = [];

  for (const entry of input.item.ai_monthly_searches ?? []) {
    // The month must be 1-12. A vendor sending 13 is malformed, and writing
    // "2026-13" would sort after every real month and read as the newest point on
    // the chart — a plausible-looking number in the wrong place.
    if (!Number.isInteger(entry.month) || entry.month < 1 || entry.month > 12) {
      continue;
    }
    rows.push({
      keyword: input.keyword,
      projectId: input.projectId,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      // Passed through untouched: 0 stays 0, null stays null.
      aiSearchVolume: entry.ai_search_volume ?? null,
      month: `${entry.year}-${String(entry.month).padStart(2, "0")}`,
      capturedAt: input.now.toISOString(),
    });
  }

  return rows;
}

/**
 * The night's shape. **Not exported** — the cron caller reads the fields off the
 * returned value, and an exported type nothing imports is a claim about the API
 * surface that is not true. Same reasoning as `AiModeNightReport`.
 */
/**
 * **Extends the shared `BudgetedCaptureReport`**, so the measured cost, the estimate
 * and the dropped-work count are the three fields every budgeted nightly capture
 * reports — and a fourth one cannot omit the first two.
 */
type AiKeywordNightReport = BudgetedCaptureReport & {
  /** Keywords whose demand we asked about, after batching. */
  keywordsAsked: number;
  /** Monthly rows stored. Larger than `keywordsAsked` — one keyword is many months. */
  rowsStored: number;
  /** Calls actually made. One per batch, not one per keyword. */
  callsMade: number;
  /** One line per failed project for the cron log. */
  failures: Array<{ projectId: string; reason: string }>;
};

/**
 * Capture monthly AI keyword demand for every project asking questions.
 *
 * `limitProjects` is the same first-deploy safety valve the other sweeps carry: an
 * unbounded sweep across every customer in one tick is not a launch, it is an
 * incident.
 */
export async function runDueAiKeywordCaptures(input?: {
  limitProjects?: number;
  now?: Date;
  fetchProjects?: typeof projectsWatchingKeywords;
  fetchVolume?: typeof fetchAiKeywordVolume;
  writeRows?: typeof GeoRunRepository.upsertAiKeywordMetrics;
}): Promise<AiKeywordNightReport> {
  const now = input?.now ?? new Date();
  const limit = input?.limitProjects ?? 25;
  const fetchProjects = input?.fetchProjects ?? projectsWatchingKeywords;
  const fetchVolume = input?.fetchVolume ?? fetchAiKeywordVolume;
  const writeRows = input?.writeRows ?? GeoRunRepository.upsertAiKeywordMetrics;

  const watchers = await fetchProjects();

  const report: AiKeywordNightReport = {
    projectsVisited: 0,
    keywordsAsked: 0,
    rowsStored: 0,
    callsMade: 0,
    droppedForBudget: 0,
    actualCostUsd: 0,
    estimatedCostUsd: 0,
    failures: [],
  };

  // Remaining budget for the whole night, shared deliberately: the alternative —
  // a full budget per project — makes the night's ceiling depend on how many
  // customers happen to be asking, which is the same bug the AI Mode runner
  // explicitly fixed the other way round.
  let remaining = AI_KEYWORD_NIGHTLY_BUDGET_USD;

  for (const watcher of watchers.slice(0, limit)) {
    report.projectsVisited += 1;

    const keywords = watcher.keywords.slice(0, VENDOR_MAX_KEYWORDS);
    if (watcher.keywords.length > keywords.length) {
      report.droppedForBudget += watcher.keywords.length - keywords.length;
    }
    if (keywords.length === 0) continue;

    /**
     * Cost is per **call**, and the planner must know how many calls it is about to
     * make before it makes the first one — a cap checked afterwards is a report of an
     * overspend, not a limit on one.
     *
     * **`keywords` is already sliced to the vendor's cap, so this is always 1** —
     * and the previous line computed `Math.ceil(keywords.length / VENDOR_MAX_KEYWORDS)`,
     * which divides an already-truncated list by the same cap and can only ever
     * return 1. So the expression *looked* like a batch calculation and was a constant.
     *
     * **It is written as 1 with the reason above rather than as the division**,
     * because a reader who sees `Math.ceil` will believe it accounts for batching and
     * will not re-derive that the input was truncated one line earlier. The honest
     * shape for "this loop makes exactly one call" is the number 1.
     *
     * The `> VENDOR_MAX_KEYWORDS` case above drops the overflow and **names it**, so
     * the truncation is visible in the report rather than hidden inside an arithmetic
     * expression that returns 1 either way.
     */
    const calls = 1;
    const cost = calls * AI_KEYWORD_UNIT_COST_USD;

    if (cost > remaining) {
      report.droppedForBudget += keywords.length;
      continue;
    }

    try {
      const response = await fetchVolume({
        keywords,
        locationCode: watcher.locationCode,
        languageCode: watcher.languageCode,
      });

      const rows = [];
      for (const item of response.data.items ?? []) {
        rows.push(
          ...toMonthlyRows({
            projectId: watcher.projectId,
            // The **vendor's** keyword, not ours: `ai-keywords.ts` normalises on
            // both sides precisely so the returned string is a safe join key, and
            // the table is keyed on it.
            keyword: item.keyword,
            locationCode: watcher.locationCode,
            languageCode: watcher.languageCode,
            item,
            now,
          }),
        );
      }

      if (rows.length > 0) {
        await writeRows(rows);
      }

      report.keywordsAsked += keywords.length;
      report.rowsStored += rows.length;
      report.callsMade += calls;
      report.estimatedCostUsd += cost;
      // **The vendor's figure, not the estimate.** Reading it is what makes the
      // unverified `AI_KEYWORD_UNIT_COST_USD` placeholder correctable: the two are
      // reported side by side precisely so their divergence is visible on the very
      // first real night.
      report.actualCostUsd += response.billing.costUsd;
      remaining -= cost;
    } catch (error) {
      // **No retry.** The request was metered and we do not know whether it
      // landed, so a second attempt can bill twice for one night. The failure is
      // named in the report so the next tick can be read against it.
      report.failures.push({
        projectId: watcher.projectId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}
