import { sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { user } from "./better-auth-schema";

// See src/db/pg/app.schema.ts for why timestamps are ISO-8601 UTC text.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * Operator-set billing knobs. This is the Postgres mirror of
 * `src/db/billing-config.schema.ts`.
 *
 * Keep it in lockstep with the SQLite one. `src/db/schema-parity.test.ts` enforces the table set,
 * columns, nullability, types, defaults, primary keys and indexes; it does **not** check the
 * migration files. So run `pnpm db:generate:pg` and commit the new `drizzle-pg/` migration, or a
 * Postgres deploy misses the table silently.
 *
 * The rationale for every column lives in the SQLite file. Do not fork it.
 */
export const billingConfig = pgTable("billing_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedByUserId: text("updated_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  updatedAt: text("updated_at").notNull().default(isoNow),
});
