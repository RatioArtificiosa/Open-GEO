import { sql } from "drizzle-orm";
import { index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { projects } from "./app.schema";
import { geoSnapshots } from "./geo.schema";

/**
 * One vendor call, preserved whole — Postgres mirror of
 * `src/db/vendor-tasks.schema.ts`.
 *
 * Keep in lockstep with the SQLite one. `src/db/schema-parity.test.ts` enforces
 * table set, columns, nullability, types, defaults, enums, PKs, unique and
 * partial indexes, FKs and check-constraint names — but NOT the migration
 * files, so run `pnpm db:generate:pg` and commit the new `drizzle-pg/` migration
 * or a Postgres deploy silently misses the change.
 *
 * The rationale lives in the SQLite file; do not fork it.
 */
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const geoVendorTasks = pgTable(
  "geo_vendor_tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id").references(() => geoSnapshots.id, {
      onDelete: "cascade",
    }),
    path: text("path").notNull(),
    requestBody: text("request_body"),
    tag: text("tag"),
    vendorTaskId: text("vendor_task_id"),
    responseBody: text("response_body"),
    statusCode: integer("status_code"),
    costUsd: integer("cost_usd"),
    chargedUsd: integer("charged_usd"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    index("geo_vendor_tasks_project_started_idx").on(
      table.projectId,
      table.startedAt,
    ),
    index("geo_vendor_tasks_vendor_task_idx").on(table.vendorTaskId),
    index("geo_vendor_tasks_snapshot_idx").on(table.snapshotId),
  ],
);
