import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

/**
 * Alert delivery log — Postgres mirror of `src/db/alert-dispatches.schema.ts`.
 *
 * Keep in lockstep with the SQLite one; `src/db/schema-parity.test.ts` enforces
 * the shape but NOT the migrations, so run `pnpm db:generate:pg`.
 *
 * The rationale for every column is in the SQLite file; do not fork it.
 */

const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const geoAlertDispatches = pgTable(
  "geo_alert_dispatches",
  {
    // App-generated UUID on both dialects. This was `serial`; the writer at
    // `alertDispatch.ts` passes `crypto.randomUUID()`, so on Postgres the insert
    // threw `invalid input syntax for type bigint`, its `catch` swallowed it,
    // the alert *was* delivered but never logged, and the next tick's duplicate
    // check could not see the row — duplicate alerts on every patrol. Because
    // the failure is caught, nothing surfaces. `drizzle-pg/0038` converts the
    // existing column.
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status", { enum: ["sent", "failed"] })
      .notNull()
      .default("sent"),
    subject: text("subject").notNull(),
    changeCount: integer("change_count").notNull().default(0),
    detail: text("detail"),
    dispatchedAt: text("dispatched_at").notNull().default(isoNow),
  },
  (table) => [
    index("geo_alert_dispatches_project_idx").on(table.projectId, table.status),
    index("geo_alert_dispatches_run_idx").on(table.projectId, table.runId),
    // Partial, and the reason is in the SQLite file: a failed attempt must be
    // insertable again so the retry is not a constraint violation.
    uniqueIndex("geo_alert_dispatches_sent_once_idx")
      .on(table.projectId, table.fingerprint)
      .where(sql`${table.status} = 'sent'`),
  ],
);
