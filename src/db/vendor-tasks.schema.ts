import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { projects } from "@/db/app.schema";
import { geoSnapshots } from "./geo.schema";

/**
 * One vendor call, preserved whole: what we sent, what came back, what it cost.
 *
 * ## Why this table exists
 *
 * Every other GEO table stores *derived* numbers — mentions, volumes, citation
 * counts. Those are only as good as the model that produced them, and DataForSEO
 * changes models without warning. The ETV formula change on 2026-11-01 is the
 * worked example: an archived ETV value with no record of which formula produced
 * it becomes **unreadable** on that date, and there is no way to tell a genuine
 * drop from a model change.
 *
 * So this stores the inputs and the raw output beside them. A stored metric can
 * then be re-derived and compared against the value we shipped, which is the only
 * way to answer a customer's "your number went down, was that us?" honestly.
 *
 * ## The cost columns are not redundant with the billing ledger
 *
 * Autumn is the system of record for what a customer was *charged*. This table
 * records what DataForSEO *billed us*, which is the number a dispute is
 * reconciled against and the one a margin question needs. They differ whenever a
 * call fails after being charged, and a null `costUsd` is meaningful: the call
 * produced no cost to reconcile, which is not the same as costing nothing.
 *
 * ## Not in this table: credentials
 *
 * The request body is stored, and a request body is not a secret — but neither
 * this table nor the secrets scan's allowlist should be extended to hold one.
 * `DATAFORSEO_API_KEY` is read from the environment and never enters a task
 * payload, so a request body here cannot contain it.
 *
 * ## Why its own file
 *
 * `geo.schema.ts` is at the 400-line cap, and this table's rationale is longer
 * than most columns. Splitting it out keeps the explanation with the definition
 * instead of compressing either one. The Postgres mirror is
 * `src/db/pg/vendor-tasks.schema.ts` and `schema-parity.test.ts` is what keeps
 * the two from drifting.
 */
export const geoVendorTasks = sqliteTable(
  "geo_vendor_tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /**
     * The run that caused this call, when it was caused by one. Null for a call
     * made on a user's behalf directly, which is the honest value: we do not
     * invent a run for a request that had none.
     */
    snapshotId: text("snapshot_id").references(() => geoSnapshots.id, {
      onDelete: "cascade",
    }),
    /** Response path segments, e.g. `v3/ai_optimization/llm_mentions/search/live`. */
    path: text("path").notNull(),
    /**
     * What we sent, verbatim. A metric that cannot be re-derived from its own
     * request is not reproducible, and "reproducible" is the whole claim.
     */
    requestBody: text("request_body"),
    /**
     * The correlation tag we set, if any. The only reliable join back to a
     * specific keyword when a `task_post` returns many tasks.
     */
    tag: text("tag"),
    /** Vendor task id, once assigned. Null for a Live call that returns no id. */
    vendorTaskId: text("vendor_task_id"),
    /** What came back, verbatim. Truncated rather than dropped if enormous. */
    responseBody: text("response_body"),
    /** Vendor status code, so a 2xx that failed a task is still distinguishable. */
    statusCode: integer("status_code"),
    /** What DataForSEO billed us, in USD. Null means no cost to reconcile. */
    costUsd: integer("cost_usd"),
    /** What we charged the customer, when a meter wrapped this call. */
    chargedUsd: integer("charged_usd"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    // The evidence read: every call for a project, newest first.
    index("geo_vendor_tasks_project_started_idx").on(
      table.projectId,
      table.startedAt,
    ),
    // The reconciliation read: every call that produced one vendor task id.
    index("geo_vendor_tasks_vendor_task_idx").on(table.vendorTaskId),
    index("geo_vendor_tasks_snapshot_idx").on(table.snapshotId),
  ],
);
