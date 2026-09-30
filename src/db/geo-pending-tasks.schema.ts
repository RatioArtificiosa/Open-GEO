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
 * One posted-but-uncollected LLM Response task.
 *
 * ## Why this is a table and not a status on `geo_answers`
 *
 * The queue is *asynchronous*, and the archive is not. A `task_post` returns an
 * id and a $0.01 advance; the answer itself may not arrive for **up to 72 hours**
 * (DataForSEO's documented worst case, after which the task is marked failed and
 * the advance refunded). So there is a window — potentially three days long — in
 * which we have paid for a prompt, hold an id, and have **no row to attach it
 * to**. Writing a `geo_answers` row with a null body and a "pending" status would
 * be the obvious move, and it is wrong twice:
 *
 * 1. `geo_answers` is **evidence of a claim the product made to a customer** — a
 *    prompt, a platform, a timestamp, a citation set. A row with no answer in it
 *    is a row the dashboard would have to render, and "we asked and are waiting"
 *    is not a visibility result.
 * 2. The same answer may legitimately be fetched more than once (a re-run of the
 *    same prompt), so the task id is not one-to-one with an answer row.
 *
 * So the pending work is its own table, and the archive only ever contains
 * answers that actually exist.
 *
 * ## The 72-hour ceiling is encoded, not commented
 *
 * `MAX_PENDING_AGE_MS` is the vendor's own documented worst case plus an hour's
 * margin. A task past it is not "still running" — the vendor has already given up
 * on it and refunded us, so treating it as pending forever would show a
 * permanently-incomplete capture plan. The reaper marks those `expired` and says
 * so, because **"we never got this answer" and "we are still waiting" are
 * different claims and only the second is true for three days.**
 *
 * ## `tag` is the only reliable link back
 *
 * A `task_post` returns ids in submission order on a *different call* than the
 * one that produced them, and a batch can be partially accepted. So each task
 * carries our own `tag` — `${answerId}:${platform}` — echoed by the vendor on
 * both the post response and `tasks_ready`. Matching by array position is the
 * obvious bug and it is silent: one rejected entry shifts every subsequent task
 * onto the wrong answer, and the archive fills with plausible mismatches.
 */
export const geoPendingTasks = sqliteTable(
  "geo_pending_tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /**
     * The snapshot this work belongs to. Null until the collection writes one,
     * because the snapshot is created *by* the collection, not before it.
     */
    snapshotId: text("snapshot_id"),
    /**
     * Our own correlation tag, echoed by the vendor. The join back to a prompt.
     */
    tag: text("tag").notNull(),
    /** The vendor's task id, the thing `task_get` is called with. */
    vendorTaskId: text("vendor_task_id").notNull(),
    /** Which queue this is on, so the drain can call the right path. */
    se: text("se").notNull(),
    modelName: text("model_name").notNull(),
    /** The prompt, stored so a re-post after expiry sends the same thing. */
    prompt: text("prompt").notNull(),
    status: text("status", {
      enum: ["pending", "collected", "failed", "expired"],
    })
      .notNull()
      .default("pending"),
    /**
     * What the vendor charged at post time — the $0.01 advance, not the model's
     * final cost. Settled by the collection, and the two are different money.
     */
    advanceUsd: integer("advance_usd"),
    /**
     * The settled cost from `task_get`. Null until collected, and null on an
     * expiry where the advance was refunded — which is a *zero*, not an absence,
     * so the reaper records `failed` rather than inventing a number.
     */
    settledUsd: integer("settled_usd"),
    /** The vendor's own failure reason, kept verbatim. */
    errorMessage: text("error_message"),
    postedAt: text("posted_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    completedAt: text("completed_at"),
  },
  (table) => [
    // The drain: everything still waiting, oldest first, so a backlog drains in
    // the order it was paid for.
    index("geo_pending_tasks_pending_idx").on(table.status, table.postedAt),
    // The reaper: pending rows old enough to be presumed expired.
    index("geo_pending_tasks_posted_idx").on(table.postedAt),
    // Idempotency. A retried post must not create a second row for the same
    // task, or the same answer gets collected twice and the archive counts a
    // duplicate.
    uniqueIndex("geo_pending_tasks_vendor_task_idx").on(table.vendorTaskId),
    // One prompt per project/platform at a time. Two posts of the same tag would
    // both be billed and only one could be attached.
    uniqueIndex("geo_pending_tasks_tag_idx").on(table.projectId, table.tag),
  ],
);

/**
 * DataForSEO's documented worst case for a Standard task, plus an hour.
 *
 * Exported because the reaper, the capture plan, and the report that says "this
 * prompt never came back" all have to agree on it, and a threshold duplicated in
 * three files is a threshold that will disagree.
 *
 * The comment above explains why this is a ceiling rather than a target.
 */
export const MAX_PENDING_AGE_MS = 72 * 60 * 60 * 1000 + 60 * 60 * 1000;
