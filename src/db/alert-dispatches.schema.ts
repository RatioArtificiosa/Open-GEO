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
 * One row per alert we tried to deliver.
 *
 * ## The fingerprint is the idempotency key, and it is a *content* hash
 *
 * Not a run id. A run can legitimately produce two different decisions — the
 * drain collects twice and finds something new the second time — and keying on
 * the run alone would suppress the second alert as a duplicate of the first. Not
 * a timestamp either: a retried dispatch of the same decision must look
 * identical, and a fingerprint containing "now" would differ between attempts and
 * defeat the whole mechanism.
 *
 * So it is the run's identity plus the rendered changes, and nothing that moves
 * between attempts. `AlertMessage.fingerprint` builds it; this column is where it
 * lands.
 *
 * ## `status` is not decoration
 *
 * A **failed** send is recorded, and the duplicate check ignores failed rows so
 * the next tick retries. The alternative — writing `sent` either way, for a
 * simpler code path — means a transient webhook outage produces a row that
 * suppresses the retry, which converts a blip into a **permanently lost
 * regression alert**. A row that says "sent" for something nobody received is
 * worse than no row, because it is believed.
 *
 * The unique index is over `(project_id, fingerprint)` **where status is
 * `sent`**, not over the fingerprint alone: a failed attempt must be insertable
 * again on the next tick, and a unique index that blocked that would turn the
 * retry path into a constraint violation.
 */
export const geoAlertDispatches = sqliteTable(
  "geo_alert_dispatches",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The patrol run this came from. Not unique — see the fingerprint. */
    runId: text("run_id").notNull(),
    /** Content identity, from `AlertMessage.fingerprint`. */
    fingerprint: text("fingerprint").notNull(),
    status: text("status", { enum: ["sent", "failed"] })
      .notNull()
      .default("sent"),
    /** The subject line, so a reader can see what was said without the body. */
    subject: text("subject").notNull(),
    changeCount: integer("change_count").notNull().default(0),
    /** The transport's own error, verbatim. Never our paraphrase of it. */
    detail: text("detail"),
    dispatchedAt: text("dispatched_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    // The duplicate check's read.
    index("geo_alert_dispatches_project_idx").on(table.projectId, table.status),
    // "What has this run told them?", for the run log.
    index("geo_alert_dispatches_run_idx").on(table.projectId, table.runId),
    // The idempotency guarantee, and it is **partial** for the reason above: a
    // failed attempt must be insertable again, so only `sent` rows collide.
    uniqueIndex("geo_alert_dispatches_sent_once_idx")
      .on(table.projectId, table.fingerprint)
      .where(sql`${table.status} = 'sent'`),
  ],
);
