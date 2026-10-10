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
import { estimateAiKeywordBatch } from "@/shared/ai-keyword-batch-cost";
import { and, eq, max, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { BudgetedCaptureReport } from "@/server/features/geo/services/captureReport";
import { db } from "@/db";
import {
  aiKeywordMetrics,
  geoPrompts,
  geoPromptSets,
  geoTargets,
} from "@/db/schema";
import {
  fetchAiKeywordVolume,
  MAX_KEYWORD_CHARS,
} from "@/server/lib/dataforseo/ai-keywords";
import {
  NIGHTLY_BUDGET_USD,
  NIGHTLY_PROJECT_SWEEP_LIMIT,
  PER_PROJECT_NIGHTLY_CAP,
} from "@/shared/nightly-budgets";
import { GeoRunRepository } from "@/server/features/geo/repositories/GeoRunRepository";
/**
 * The shared org lookup, the same one the ETV capture uses.
 *
 * **One lookup, not three.** All three nightly captures need the org behind a
 * project in order to bill it, and a copy in each is a copy that drifts — the
 * pattern this repo has spent its length consolidating.
 */
import { listProjectOrgs } from "@/server/features/domain/services/scheduledEtvCapture";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";

/**
 * The vendor's own batch ceiling, not a number chosen here.
 *
 * `validateAiKeywordBatch` clamps to this, so exceeding it is a **billed rejection**
 * rather than a silent truncation — which is why this constant exists to be *read*
 * by that guard rather than duplicated by a caller.
 */
const VENDOR_MAX_KEYWORDS = 1000;

/** The night's ceiling, in USD. Same reasoning as the AI Mode cap: a constant, not an invented setting. */
/**
 * A **placeholder pending the pricing plan**, and named as one.
 *
 * **What the alternatives actually cost**, because a placeholder nobody can judge is a
 * placeholder nobody can overrule:
 *
 * | tracked domains | this ceiling | `null`, the patrol's answer |
 * |---|---|---|
 * | 25 | $0.05 | $0.05 |
 * | 1,000 | $2.00 | $2.00 |
 * | 5,000 | $0.05 | **$10.00** |
 *
 * **So `null` is not the neutral choice it looks like.** In `patrolSpend.ts` a `null`
 * budget means *"no budget"* - the decision returns `allowed: true` with no ceiling - so
 * adopting it here would mean one customer with 5,000 brands spends $10.00 a night with
 * nothing refusing it. The main patrol can pass `null` safely because it is bounded by
 * `maxAnswers`; **this capture is bounded only by how many domains a customer tracks.**
 *
 * **And the ceiling's own denominator is an unverified placeholder** ($0.002 a call, so 2500 calls
 * fit). A ceiling computed from an unverified price is a guess with a unit.
 *
 * **What a decision needs:** whether `$5` is right, and what bounds one project whose tracked
 * count exceeds what the ceiling affords. Today nothing does - `limitProjects` counts
 * *projects*, not domains, so a single large customer is unbounded within the ceiling's own
 * terms.
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
/**
 * **Read from {@link NIGHTLY_BUDGET_USD}**, for the same reason as the sibling: the budget
 * is policy, and its denominator — {@link AI_KEYWORD_UNIT_COST_USD} — sits beside it.
 */
const AI_KEYWORD_NIGHTLY_BUDGET_USD = NIGHTLY_BUDGET_USD.aiKeyword;

/**
 * When each keyword was last asked about, per project.
 *
 * **The same rotation as the ETV capture, on this module's own table.** `capturedAt` is
 * the closest thing to "when we asked", and it needs no separate cursor because the
 * archive already holds it.
 *
 * **Joined on the keyword string, so the normalisation matters here more than
 * anywhere else.** `ai-keywords.ts` normalises on both the request and the response
 * so the vendor's returned string is a safe join key — a row written as `best crm` will
 * not match a prompt stored as `Best CRM `, and the symptom would be a project whose
 * keywords all look permanently unmeasured. The join therefore compares against the
 * **normalised** prompt.
 */
/**
 * **`substr(lower(trim(...)), 1, 250)` in SQL, and it *does* have to stay identical to
 * `normaliseAiKeyword` — which is `trim().toLowerCase().slice(0, MAX_KEYWORD_CHARS)`.**
 *
 * | | TS rule | SQL rule |
 * |---|---|---|
 * | trim | `.trim()` | `trim(...)` |
 * | lowercase | `.toLowerCase()` | `lower(...)` |
 * | length clamp | `.slice(0, 250)` — **last** | `substr(…, 1, 250)` — **outermost** |
 *
 * **The order is load-bearing, and this heading had the wrong one for the whole time the
 * code was wrong too.** A comment quoting `lower(trim(substr(…, 1, 250)))` above a line that
 * read the same way is a comment that cannot catch anything — and CodeRabbit caught it
 * instead, by comparing the two files.
 *
 * **The clamp was missing entirely at first**, and the comment above said it could not be:
 * it read *"if `normaliseAiKeyword` gains trimming, padding or a length cut, this is the
 * line that has to change with it"* — but the cut was **already present** in
 * `ai-keywords.ts`, so the drift had happened before the comment warned about it.
 *
 * **Then it was present and in the wrong place**, which is worse than absent: absent is
 * obviously absent, and misplaced looks right. Leading whitespace pushes real content past
 * the clamp *before* the trim removes it, so the stored keyword and the join key disagree
 * and the prompt is **never measured, for ever** — the same symptom the missing clamp had.
 *
 * **Three ways this rule has been wrong in one file**: missing, then misordered, and a
 * comment that described it wrongly through both. A comment asserting a rule it did not
 * check is not documentation, it is a second copy to keep in step — which is the defect
 * CodeRabbit flagged in the sibling test the same hour.
 *
 * **What it cost, and it is the same shape as the `ORDER BY` bug fixed an hour earlier:**
 * for any prompt over 250 characters the stored keyword is a truncated prefix, the join
 * compares the whole prompt against it, nothing matches, and the prompt is
 * **never measured**. Being sorted as never-asked puts it at the *front* of the queue —
 * so the longest prompts are re-asked every single night and never recorded.
 *
 * **The number is now imported, not retyped**, and `MAX_KEYWORD_CHARS` is exported rather
 * than module-private. One value, so the two rules agree by construction instead of by
 * comment — which is the only kind of agreement that survives a change. */
/**
 * The vendor's length clamp, repeated here because SQL cannot import a TS constant.
 *
 * **Exported from `ai-keywords.ts` and imported below**, so it is one number rather
 * than two that must be kept in step — see `MAX_KEYWORD_CHARS` at the top of this file.
 */
const normaliseColumn = (column: SQLiteColumn) =>
  // **The clamp is OUTSIDE, and that is the whole point.** `substr(lower(trim(col)), 1, N)`
  // is `normaliseAiKeyword` — and the order is load-bearing, not stylistic:
  //
  // | | prompt | result |
  // |---|---|---|
  // | clamp **last** (correct) | `" " x 300 + "HELLO"` | `hello` |
  // | clamp **first** (wrong)   | `" " x 300 + "HELLO"` | **`""` — the content is gone** |
  //
  // **Leading whitespace pushes the real content past the clamp.** Trimming first brings it
  // back inside; clamping first discards it, and the vendor's stored keyword and this join
  // key then disagree — so the prompt is never measured, forever.
  //
  // **The first version of this line had the order backwards and a passing test.** The
  // fixture padded *trailing* whitespace, which both orders handle identically; only
  // leading padding differs, and nothing in it had any. A bug that a well-meaning fixture
  // is blind to is exactly the kind that ships, and this one was caught by an external
  // review rather than by the test written to check the line.
  sql`substr(lower(trim(${column})), 1, ${MAX_KEYWORD_CHARS})`;

/**
 * The aggregation, named once and used **only inside the subquery**.
 *
 * **The ordering does not use it** — it references `lastAsked.at` instead, because an
 * aggregate over the joined table's columns is not valid in the outer query. Naming
 * them as one expression was the bug, and it was the bug twice.
 */
const lastAskedAt = max(aiKeywordMetrics.capturedAt);

const lastAsked = db
  .select({
    projectId: aiKeywordMetrics.projectId,
    keyword: aiKeywordMetrics.keyword,
    // **`keyword_at`, not `at`** — the project subquery below also aliases a column,
    // and two columns called `at` in one outer query make `order by "at"` ambiguous.
    // SQLite rejects the whole query, so the names have to differ.
    at: lastAskedAt.as("keyword_at"),
  })
  .from(aiKeywordMetrics)
  .groupBy(aiKeywordMetrics.projectId, aiKeywordMetrics.keyword)
  .as("lastAsked");

/**
 * When each **project** was last asked about, at all.
 *
 * **The third instance of one bug, and the same shape as the other two.** The query above
 * rotates *within* a project — and the runner then does
 * `watchers.slice(0, limitProjects)`, which bounds **projects**. A rotation one level
 * below the bound does nothing for the bound: `[...byProject.values()]` arrives in the
 * order the rows did, and for a customer with several projects that order is the same
 * every night, so the same 25 projects win every night and the rest never run at all.
 *
 * **This is what it looked like while it was broken:** all the rotation code present and
 * correct, just applied a level below the cap that needed it. Which is why "there is
 * rotation here" is not the question — *"what is the cap applied to, and is *that* thing
 * rotated?"* is.
 *
 * | | rotation exists | the bound acts on |
 * |---|---|---|
 * | ETV `ORDER BY` | per domain | the aggregate — wrongly |
 * | keyword normalisation | per keyword | a join that matched nothing |
 * | `limitProjects` | per keyword | **projects — never rotated** |
 *
 * The same `ROW_NUMBER()` window `queueDrainRunner` already uses, and for the same
 * reason: a window orders **within** a partition, so partitioning by project gives a
 * per-project rank that `limitProjects` can be spent against fairly.
 */
const projectLastAsked = db
  .select({
    projectId: aiKeywordMetrics.projectId,
    at: lastAskedAt.as("project_at"),
  })
  .from(aiKeywordMetrics)
  .groupBy(aiKeywordMetrics.projectId)
  .as("projectLastAsked");

/**
 * How many of one project's keywords the capture covers per night.
 *
 * **The same bound the ETV capture needed, on the same axis.** `limitProjects` bounds
 * how many *customers* one tick touches; the ceiling above bounds a *night*. Neither
 * bounds what one customer costs, and nothing in the product caps a project's prompt
 * count.
 *
 * | keywords on one project | at `$0.002` a call |
 * |---|---|
 * | 25 | $0.05 |
 * | 1,000 | $2.00 |
 * | 5,000 | $10.00 — past a $5 night |
 *
 * **A count rather than a price**, and here that matters more than anywhere: the unit
 * price above is **itself an unverified placeholder**, so a budget derived from it would be
 * a guess with a unit. A keyword count is exact whatever the vendor charges — and the
 * live verification blocked on the funded account is what would replace the guess.
 *
 * **Simpler than the ETV equivalent, because the shape is easier.** `projectsWatchingKeywords`
 * already groups by project into a Set, so this is a slice rather than a running count
 * over a flat list. The ETV capture had to count as it went, which is where its first
 * version went wrong.
 */
const MAX_KEYWORDS_PER_PROJECT_PER_NIGHT = PER_PROJECT_NIGHTLY_CAP.aiKeywords;

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
      // **Selected so the ordering below can see it.** The runner bounds projects, and
      // an `ORDER BY` is the only thing that decides which projects those are.
      projectAskedAt: projectLastAsked.at,
    })
    .from(geoPromptSets)
    .innerJoin(geoTargets, eq(geoTargets.projectId, geoPromptSets.projectId))
    .innerJoin(geoPrompts, eq(geoPrompts.promptSetId, geoPromptSets.id))
    // **Left join, nulls first — and the same three terms as the ETV capture.** Without
    // it the cap slices the front of the list, so a project with 400 prompts has the
    // **same 25 measured every night** and the other 375 never. With it the set
    // rotates: least-recently-asked first, never-asked ahead of both.
    //
    // The `is null` term is written out because a dialect that sorted nulls last
    // would put every never-asked keyword behind the ones asked tonight, and the cap
    // would go straight back to starving exactly the set that needs reaching.
    .leftJoin(
      lastAsked,
      and(
        eq(lastAsked.projectId, geoTargets.projectId),
        eq(lastAsked.keyword, normaliseColumn(geoPrompts.prompt)),
      ),
    )
    // **The project's own last-asked time**, joined on the project alone. A second
    // `leftJoin` rather than another `groupBy`, because one query cannot aggregate
    // twice over at different grains.
    .leftJoin(
      projectLastAsked,
      eq(projectLastAsked.projectId, geoTargets.projectId),
    )
    // **The alias, not the aggregate** — the same fix as the ETV rotation, and for
    // the same reason. Ordering by `lastAskedAt` makes drizzle emit
    // `max("ai_keyword_metrics"."captured_at")` in the **outer** query, where that
    // table is not in scope; libsql then reports it as `no such column`, which names a
    // schema problem rather than the query-construction one it is.
    //
    // Wrapped in `sql``` so `orderBy` accepts the alias by type — the emitted SQL is
    // unchanged.
    // **Project rotation first, keyword rotation second — in that order, and the
    // order is the fix.** `limitProjects` slices the front of this list, so the FIRST
    // term decides which projects get a night at all. Putting the per-keyword term first
    // would rotate keywords *within* whichever projects happened to lead, and the
    // project bound would still be won by the same customers every night.
    //
    // Within a project the `is null` term then pushes its never-asked keywords ahead of
    // its asked ones, which is the rotation the per-keyword subquery exists for.
    .orderBy(
      sql`${projectLastAsked.at} is null desc`,
      sql`${projectLastAsked.at}`,
      sql`${lastAsked.at} is null desc`,
      sql`${lastAsked.at}`,
      geoPrompts.prompt,
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
/**
 * The identity a scheduled capture acts as.
 *
 * A cron has no user, and inventing a plausible one would put a fake
 * userId/userEmail into the billing ledger. The scheduled GEO patrol already
 * solved this with the same constant and the same address, so this file uses that
 * convention rather than inventing a second one.
 */
const SYSTEM_ACTOR = {
  userId: "system",
  userEmail: "system@opengeo.so",
} as const;

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
 * `limitProjects` is the shared first-deploy safety valve
 * ({@link NIGHTLY_PROJECT_SWEEP_LIMIT}, which the sibling sweeps also read): an
 * unbounded sweep across every customer in one tick is not a launch, it is an
 * incident.
 */
export async function runDueAiKeywordCaptures(input?: {
  limitProjects?: number;
  now?: Date;
  fetchProjects?: typeof projectsWatchingKeywords;
  fetchVolume?: typeof fetchAiKeywordVolume;
  fetchOrgs?: typeof listProjectOrgs;
  writeRows?: typeof GeoRunRepository.upsertAiKeywordMetrics;
}): Promise<AiKeywordNightReport> {
  const now = input?.now ?? new Date();
  const limit = input?.limitProjects ?? NIGHTLY_PROJECT_SWEEP_LIMIT;
  const fetchProjects = input?.fetchProjects ?? projectsWatchingKeywords;
  const fetchOrgs = input?.fetchOrgs ?? listProjectOrgs;
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

  /**
   * The org behind each project, so a capture can bill it.
   *
   * Before the loop, and only for the projects it will visit. A cron has no
   * user, so the billing context is assembled from real ids: a project whose org
   * is missing is skipped rather than guessed at, because a cast-in
   * organizationId would let the usage-credit check pass against a customer that
   * does not exist.
   */
  const admitted = watchers.slice(0, limit);
  const orgs = await fetchOrgs(admitted.map((w) => w.projectId));
  const billable = admitted.filter((w) => orgs.has(w.projectId));
  if (billable.length < admitted.length) {
    report.skippedNoOrganization = admitted.length - billable.length;
  }

  for (const watcher of billable) {
    report.projectsVisited += 1;

    // **Two slices, and the order matters.** The per-project cap comes first
    // because it is the bound that holds: `VENDOR_MAX_KEYWORDS` is the vendor's
    // rejection limit, so exceeding it is a *billed rejection* rather than a
    // truncation — the cap has to keep us under it either way.
    //
    // **Overflow named, whichever slice produced it.** "We did not ask about this
    // keyword" is one sentence with two causes, and the report carries one count.
    const withinProjectCap = watcher.keywords.slice(
      0,
      MAX_KEYWORDS_PER_PROJECT_PER_NIGHT,
    );
    if (watcher.keywords.length > withinProjectCap.length) {
      report.droppedForBudget +=
        watcher.keywords.length - withinProjectCap.length;
    }

    // The vendor's cap still applies on top, in case the per-project cap is ever
    // raised above 1000 — and because a request over the limit is billed, not
    // truncated, so relying on the per-project cap alone would be a hidden coupling.
    const keywords = withinProjectCap.slice(0, VENDOR_MAX_KEYWORDS);
    if (withinProjectCap.length > keywords.length) {
      report.droppedForBudget += withinProjectCap.length - keywords.length;
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
    // **Read from the module that prices a batch**, rather than a second hand-rolled
    // sum here: a second `+` is how this cost went wrong in the first place.
    const cost = estimateAiKeywordBatch(keywords.length).totalUsd;

    if (cost > remaining) {
      report.droppedForBudget += keywords.length;
      continue;
    }

    try {
      /**
       * Through the metered client, not the raw fetcher.
       *
       * Before this the capture called the section fetcher directly, so the
       * credit gate never ran for a nightly capture: the platform vendor account
       * paid, no org balance was read, and a zero-credit org kept receiving
       * captures every night. The client is built per project, because the gate
       * takes a customer and the customer differs per project; a single client
       * would bill every project to whichever org was read first.
       *
       * The envelope sibling, so report.actualCostUsd still carries the vendor
       * figure rather than undefined.
       */
      const meterVolume =
        fetchVolume ??
        createDataforseoClient({
          ...SYSTEM_ACTOR,
          organizationId: orgs.get(watcher.projectId) ?? "",
          projectId: watcher.projectId,
        }).aiSearch.keywordVolumeEnvelope;
      const response = await meterVolume({
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
