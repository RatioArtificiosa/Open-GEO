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

/**
 * One row per monitor execution, for every kind of monitor — Postgres mirror of
 * `src/db/monitor-runs.schema.ts`.
 *
 * Keep in lockstep with the SQLite one. `src/db/schema-parity.test.ts` enforces
 * table set, columns, nullability, types, defaults, enums, PKs, unique and partial
 * indexes, FKs and check-constraint names — but NOT the migration files, so run
 * `pnpm db:generate:pg` and commit the new `drizzle-pg/` migration or a Postgres
 * deploy silently misses the change.
 *
 * The rationale for every column lives in the SQLite file; do not fork it.
 */

// Timestamps are stored as *text* (same column shape as SQLite); see the note in
// pg/app.schema.ts. `isoNow` matches `new Date().toISOString()` so DB-defaulted
// and app-written values sort together lexicographically.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const monitorRuns = pgTable(
  "monitor_runs",
  {
    // The one deliberate divergence from SQLite: Postgres gets a serial id
    // because it has one, and `schema-parity.test.ts` compares *presence*, not
    // the auto-increment strategy — `primaryKeyColumns` returns the same set.
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    monitorType: text("monitor_type").notNull(),
    monitorSubject: text("monitor_subject").notNull().default(""),
    platform: text("platform").notNull().default(""),
    status: text("status", {
      enum: ["pending", "running", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    plannedItems: integer("planned_items"),
    completedItems: integer("completed_items"),
    budgetUsd: integer("budget_usd"),
    costUsdMicros: integer("cost_usd_micros"),
    chargedUsdMicros: integer("charged_usd_micros"),
    errorMessage: text("error_message"),
    startedAt: text("started_at").notNull().default(isoNow),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    index("monitor_runs_project_started_idx").on(
      table.projectId,
      table.startedAt,
    ),
    index("monitor_runs_identity_idx").on(
      table.projectId,
      table.monitorType,
      table.monitorSubject,
      table.platform,
    ),
    uniqueIndex("monitor_runs_one_active_per_monitor_idx")
      .on(
        table.projectId,
        table.monitorType,
        table.monitorSubject,
        table.platform,
      )
      .where(sql`${table.status} IN ('pending', 'running')`),
  ],
);
