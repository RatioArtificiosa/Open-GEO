import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

// Timestamps are stored as *text* (same column shape as the SQLite schema); see the note in
// pg/app.schema.ts. `isoNow` matches `new Date().toISOString()` so DB-defaulted and app-written
// values sort together lexicographically.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const timestampColumn = (name: string) => text(name);

/**
 * Postgres mirror of the SQLite `geo_forecast_snapshots` table. See the SQLite definition for the
 * full rationale; the short version is that **a forecast nobody kept cannot be scored**, so the
 * nightly job appends one dated row per (project, kind, subject, model version, day) and never
 * updates one, the model version is in the unique key so two models cannot mix in a series, and
 * every measurement is nullable because a module that *declined* to forecast still produced a
 * measurement — of its own refusal.
 *
 * Integers rather than floats, because the two dialects must agree on a share exactly: a fraction
 * stored as a float is a number that differs in the seventeenth digit between SQLite and Postgres,
 * and the accuracy read is a subtraction.
 */
export const geoForecastSnapshots = pgTable(
  "geo_forecast_snapshots",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    modelVersion: text("model_version").notNull(),
    issuedOn: timestampColumn("issued_on").notNull(),
    horizonDays: integer("horizon_days").notNull(),
    shareBp: integer("share_bp"),
    lowBp: integer("low_bp"),
    highBp: integer("high_bp"),
    perWeekBp: integer("per_week_bp"),
    nowBp: integer("now_bp"),
    basedOn: integer("based_on").notNull(),
    basedOnWeeks: integer("based_on_weeks"),
    confidence: text("confidence"),
    note: text("note"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("geo_forecast_snapshots_point_idx").on(
      table.projectId,
      table.kind,
      table.subject,
      table.modelVersion,
      table.issuedOn,
    ),
    index("geo_forecast_snapshots_series_idx").on(
      table.projectId,
      table.kind,
      table.subject,
      table.issuedOn,
    ),
    index("geo_forecast_snapshots_project_idx").on(
      table.projectId,
      table.issuedOn,
    ),
  ],
);
