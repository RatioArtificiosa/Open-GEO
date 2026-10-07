import { integer, pgTable, text } from "drizzle-orm/pg-core";

/**
 * The vendor's category taxonomy. This is the Postgres mirror of
 * `src/db/labs-categories.schema.ts`.
 *
 * Keep it in lockstep with the SQLite one. `src/db/schema-parity.test.ts` enforces the table set,
 * columns, nullability, types, defaults, primary keys and indexes; it does **not** check the
 * migration files. So run `pnpm db:generate:pg` and commit the new `drizzle-pg/` migration, or a
 * Postgres deploy misses the table silently.
 *
 * The rationale for every column lives in the SQLite file. Do not fork it.
 */
export const categoryTaxonomy = pgTable("category_taxonomy", {
  criterionId: integer("criterion_id").primaryKey(),
  path: text("path").notNull(),
});
