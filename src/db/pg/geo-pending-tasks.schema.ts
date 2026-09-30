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
 * Posted-but-uncollected LLM Response tasks — Postgres mirror of
 * `src/db/geo-pending-tasks.schema.ts`.
 *
 * Keep in lockstep with the SQLite one. `src/db/schema-parity.test.ts` enforces
 * table set, columns, nullability, types, defaults, enums, PKs, unique indexes,
 * FKs and check-constraint names — but NOT the migration files, so run
 * `pnpm db:generate:pg` and commit the new `drizzle-pg/` migration.
 *
 * The rationale for every column lives in the SQLite file; do not fork it.
 */

const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const geoPendingTasks = pgTable(
  "geo_pending_tasks",
  {
    // The one deliberate divergence: Postgres gets a serial id because it has
    // one, and `schema-parity.test.ts` compares presence rather than the
    // auto-increment strategy.
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id"),
    tag: text("tag").notNull(),
    vendorTaskId: text("vendor_task_id").notNull(),
    se: text("se").notNull(),
    modelName: text("model_name").notNull(),
    prompt: text("prompt").notNull(),
    status: text("status", {
      enum: ["pending", "collected", "failed", "expired"],
    })
      .notNull()
      .default("pending"),
    advanceUsd: integer("advance_usd"),
    settledUsd: integer("settled_usd"),
    errorMessage: text("error_message"),
    postedAt: text("posted_at").notNull().default(isoNow),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("geo_pending_tasks_pending_idx").on(table.status, table.postedAt),
    index("geo_pending_tasks_posted_idx").on(table.postedAt),
    uniqueIndex("geo_pending_tasks_vendor_task_idx").on(table.vendorTaskId),
    uniqueIndex("geo_pending_tasks_tag_idx").on(table.projectId, table.tag),
  ],
);
