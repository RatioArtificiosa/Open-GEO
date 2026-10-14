import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";

/**
 * A dated forecast, one row per (project, kind, subject, model version, day).
 *
 * ## Why this table exists
 *
 * Every forecast this product makes was **computed on read and thrown away**. B1's
 * category momentum, B2's breakout verdicts, B3's visibility pace and B4's citation
 * win probability are all pure functions over stored history, and until now all of
 * them ran inside a request handler and died with the response. That has two costs,
 * and the second is the one that matters:
 *
 * 1. **The same arithmetic is redone on every read.** Cheap, and not a reason to
 *    build a table.
 * 2. **A forecast nobody kept cannot be checked.** "At this pace you reach 30% of
 *    prompts in ten weeks" is only a product sentence if, in ten weeks, the product
 *    can say what it predicted and whether it happened. A forecast recomputed from
 *    today's history is not a forecast — it is a description of today wearing a
 *    forecast's clothes, and it can never be wrong, which is exactly why it is worth
 *    nothing. **A forecast that cannot be scored against the future is decoration.**
 *
 * CL-503's *"nightly jobs over stored history"* is this table plus the sweep that
 * fills it. The sweep costs **$0.00**: every input is already in `geo_snapshots`,
 * `geo_answers`, `geo_answer_retrievals`, `geo_answer_citations`, `geoTargets` and
 * `auditReadinessReports`, so nothing here calls the vendor and nothing here can
 * overspend. B1 and B2 are *not* in this sweep for exactly that reason — they need a
 * live `google_trends/explore`, and their shape and price are recorded in
 * `specs/0021-nightly-forecast-job.md` as a founder decision rather than started
 * quietly.
 *
 * ## Why the issue date is in the unique key, and why nothing is ever updated
 *
 * `issued_on` is a **date**, and the unique index carries it beside the model
 * version and the brand. So a second run on the same night produces the same key and is ignored
 * rather than written twice, and a run on a later night produces a different key and
 * is appended. **History is append-only on purpose:** overwriting yesterday's
 * forecast with today's would delete the only evidence that the forecast changed,
 * and a reader comparing "what we said" against "what happened" would then be
 * comparing today's opinion against today's fact — a comparison that always agrees.
 *
 * ## Why the model version is NOT NULL and in the key
 *
 * Same rule as `keyword_opportunity_inputs.score_model_version`: an unstamped row is
 * unreadable the moment the weights change, and a series mixing two versions is
 * unrepresentable rather than merely discouraged.
 *
 * ## Why the numbers are basis points
 *
 * Shares and rates are fractions, and a fraction stored as a float drifts between
 * the two dialects. `ai_native_ratio_bp` set the precedent: 0–10000, integer, exact.
 * `per_week_bp` is **signed** — a falling share is a real and reportable state, and
 * an unsigned column would force a sign into a separate flag.
 *
 * ## Why every measurement is nullable
 *
 * `share_bp` and its interval are null when the underlying module
 * **declined** to forecast: too little history, no denominator, or a sample under
 * the floor. `visibilityForecast` and `citationWinProbability` both return a refusal
 * *with a reason*, and this table stores the refusal as a row with nulls and a note
 * rather than dropping it. **A night that declined is a night that was measured** —
 * dropping the row would make "we cannot forecast yet" indistinguishable from "the
 * job did not run", and the second reading is the one that gets debugged for a week.
 *
 * Postgres mirror: `src/db/pg/forecast-snapshots.schema.ts`.
 */
export const geoForecastSnapshots = sqliteTable(
  "geo_forecast_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /**
     * `visibility_forecast` | `visibility_pace` | `citation_win`.
     *
     * A text tag rather than an enum: SQLite has no enum type, and the three kinds
     * share one table because they share one job, one cadence and one
     * append-only rule. The alternative — three tables — triples the migration
     * surface and the sweep's loop for no difference in what a reader can ask.
     */
    kind: text("kind").notNull(),
    /**
     * What the row is about: the platform for the two visibility kinds, the target
     * domain for `citation_win`.
     *
     * Not a foreign key, deliberately: a subject is a *label inside the forecast*,
     * not a row of its own, and the platform is a string the vendor names. Forcing
     * it to reference a table would either invent a platforms table or forbid a
     * platform the code lists but the database has never seen.
     */
    subject: text("subject").notNull(),
    /**
     * The brand the row is about, and it is **required and in the key**.
     *
     * A project can monitor several brands — `geo_targets` is one row per
     * `(project, domain, market)`, and the patrol runs once per target. Without the
     * domain in the key, two brands in one project produce the *same* key for the
     * same platform on the same night: the second insert collides and is silently
     * dropped by `onConflictDoNothing`, so one brand's forecast quietly disappears
     * while the sweep reports having written it. Worse, a reader measuring one domain
     * would then read back the other brand's row.
     *
     * `citation_win` rows carry it twice over — `subject` is the domain and so is
     * this — which is duplication kept deliberately: the column's meaning must not
     * depend on the kind it sits beside.
     */
    domain: text("domain").notNull(),
    /**
     * The model version the numbers were computed by. NOT NULL and in the key.
     *
     * `FORECAST_MODEL_VERSION` in `forecastSnapshot.ts` is the only writer, so a
     * bump is one constant and every row it produced stays readable as history.
     */
    modelVersion: text("model_version").notNull(),
    /** `YYYY-MM-DD`, the day the forecast was made. The date, not the timestamp. */
    issuedOn: text("issued_on").notNull(),
    /** The band the projection speaks over, in days. `visibilityPace`'s 90 by default. */
    horizonDays: integer("horizon_days").notNull(),
    /**
     * The share this row is about, 0–10000 — and what that means is `kind`'s to say:
     * the projection after the horizon for `visibility_pace` and `citation_win`, the
     * reading itself for `visibility_forecast`. Kind-neutral on purpose, because a
     * column named "predicted" would misname the anchor row every time.
     */
    shareBp: integer("share_bp"),
    /** Wilson low, 0–10000. Null with `share_bp` — the interval is not optional-half. */
    lowBp: integer("low_bp"),
    /** Wilson high, 0–10000. */
    highBp: integer("high_bp"),
    /** The measured weekly change, signed, 0–10000 units per week. */
    perWeekBp: integer("per_week_bp"),
    /**
     * The share at the moment of issue, 0–10000 — the anchor any accuracy check
     * reads first. Comparing a projection against a re-read "current" value would
     * score a target that moved.
     */
    nowBp: integer("now_bp"),
    /** The denominator the estimate rests on: prompts asked, or pages retrieved. */
    basedOn: integer("based_on").notNull(),
    /** How many weeks of history the pace rests on, when the kind reports one. */
    basedOnWeeks: integer("based_on_weeks"),
    /** `none | low | moderate | high`, as `visibilityForecast` terms it. Null when unstated. */
    confidence: text("confidence"),
    /**
     * The series note, verbatim: which runs were considered, which were skipped and
     * why. Stored rather than re-derived so a reader of a six-month-old row learns
     * what that row was *allowed* to know, which is the part a re-derivation would
     * quietly rewrite against them.
     */
    note: text("note"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    // One row per (project, brand, kind, subject, model, day). Second run of the
    // same night is ignored rather than duplicated: a cron that fires twice must not
    // be able to fork a series, and the day-granularity key is what makes that
    // true without a "did we already run" table of its own. The brand is part of it
    // because a project can monitor several.
    uniqueIndex("geo_forecast_snapshots_point_idx").on(
      table.projectId,
      table.kind,
      table.domain,
      table.subject,
      table.modelVersion,
      table.issuedOn,
    ),
    // The two reads: latest per subject, and one subject's history oldest-first.
    index("geo_forecast_snapshots_series_idx").on(
      table.projectId,
      table.kind,
      table.domain,
      table.subject,
      table.issuedOn,
    ),
    // The sweep's per-project read: everything it wrote for one project, by day.
    index("geo_forecast_snapshots_project_idx").on(
      table.projectId,
      table.issuedOn,
    ),
  ],
);
