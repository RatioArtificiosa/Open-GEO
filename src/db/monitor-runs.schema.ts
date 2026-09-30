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
 * One row per monitor execution, for every kind of monitor.
 *
 * ## Why this exists when `geo_snapshots` already looks like a run
 *
 * `geo_snapshots` is an *archive* row: it is written when a patrol produces
 * answers, and deliberately **not** written when it produces none — a run that
 * found nothing leaves no trace. That is right for an archive and wrong for
 * coordination, which needs to know that a run *started*. So this table is not a
 * duplicate of it; it is the thing that can say "running" before any answer
 * exists, and that can record a run which found nothing at all.
 *
 * The same reasoning is why the GEO patrol currently has no single-in-flight
 * protection while rank tracking does: with no run row, there is nothing to
 * protect.
 *
 * ## The key is (project, monitor, subject), not project
 *
 * A project monitors several things at once — a brand on ChatGPT, a brand on
 * Google AI Overview, a set of AI Mode prompts — and each is a *separate* monitor
 * that can run concurrently. Keying on `projectId` alone would make the second
 * monitor wait for the first, which is both wrong and invisible: the wait would
 * look like "nothing to do".
 *
 * So a monitor is named by three parts:
 * - `monitorType` — which subsystem (`geo_patrol`, `ai_mode`, …).
 * - `monitorSubject` — what it watches within that subsystem, e.g. a target id or
 *   a prompt-set id. Empty string for a whole-project monitor, which is a real
 *   case rather than a null to normalise.
 * - `platform` — the vendor platform, because the same prompt on ChatGPT and
 *   Google are different monitors with different data and different cost.
 *
 * ## The index is the protection
 *
 * A partial unique index on `(project_id, monitor_type, monitor_subject,
 * platform) WHERE status IN ('pending','running')` means **the database** enforces
 * one in-flight run per monitor. That is deliberate: an application-level lock
 * cannot survive two Worker isolates, and every duplicate trigger in this system
 * — the cron, a manual button, a retry, a second region — is a separate isolate
 * by the time it matters.
 */
export const monitorRuns = sqliteTable(
  "monitor_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /**
     * Which subsystem. Free text rather than an enum so a new monitor does not
     * need a migration, and so a run is readable in the table without a join.
     */
    monitorType: text("monitor_type").notNull(),
    /**
     * What it watches. Empty string, not null, for a whole-project monitor: the
     * identity is the *triple*, and a null here would make "no subject" and "not
     * set yet" the same value.
     */
    monitorSubject: text("monitor_subject").notNull().default(""),
    /** The vendor platform, e.g. `chat_gpt`. Empty for monitors with no platform. */
    platform: text("platform").notNull().default(""),
    status: text("status", {
      enum: ["pending", "running", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    /** What the run set out to do. Null when not known in advance. */
    plannedItems: integer("planned_items"),
    /** What it actually did. Null until a run completes. */
    completedItems: integer("completed_items"),
    /**
     * The spend cap agreed for this run, in USD.
     *
     * Stored rather than read from a setting at spend time, because a cap that
     * can change mid-run is not a cap — and because the reconciliation has to
     * compare against what was agreed, not what happens to be configured now.
     */
    budgetUsd: integer("budget_usd"),
    /**
     * What the vendor billed us, in micro-dollars to keep integer precision.
     *
     * Integer rather than a float because a money column in floating point
     * accumulates the error that makes a reconciliation argument unfalsifiable.
     */
    costUsdMicros: integer("cost_usd_micros"),
    /** What the customer was charged, same units and same reason. */
    chargedUsdMicros: integer("charged_usd_micros"),
    errorMessage: text("error_message"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    completedAt: text("completed_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    // The reconciliation read: every run for a project, newest first.
    index("monitor_runs_project_started_idx").on(
      table.projectId,
      table.startedAt,
    ),
    // The "what is this monitor doing right now" read.
    index("monitor_runs_identity_idx").on(
      table.projectId,
      table.monitorType,
      table.monitorSubject,
      table.platform,
    ),
    // The protection. Scoped to the in-flight statuses so completed runs
    // accumulate freely — a unique index over all statuses would permit exactly
    // one run per monitor, ever.
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
