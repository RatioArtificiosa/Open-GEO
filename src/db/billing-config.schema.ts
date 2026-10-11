import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./better-auth-schema";

/**
 * Operator-set billing knobs. One row per knob, keyed by name.
 *
 * ## Why this table exists
 *
 * The hosted markup used to be the literal `SEO_DATA_COST_MARKUP = 1.28` in
 * `src/shared/billing.ts` — which is the *public* repository, and `src/shared/`
 * is bundled for the browser. So the platform's margin was published in three
 * places at once: the GitHub source, the client JavaScript any customer can
 * read out of devtools, and the website.
 *
 * A published rate is a promise. The markup moves with volume discounts, with
 * the market, and whenever the vendor reprices, so publishing today's number
 * makes every future adjustment a broken claim on the page that argues we do
 * not make them. The rate is therefore an operator setting, not a constant:
 * the owner sets it, in the admin area, without a deploy.
 *
 * ## Why key/value rather than a column
 *
 * The admin surface this backs is an MVP that the owner grows — "small things
 * at first, then expand". A row per knob means adding the third knob is an
 * insert and a resolver, not a migration and a rewrite of every reader. The
 * cost is that the value column is text and each knob narrows it on read,
 * which is the same trade `billingCustomerStatus.customerJson` already makes
 * for a wider reason.
 *
 * Resolution order for the markup lives in `src/server/billing/costMarkup.ts`:
 * this table, then the `BILLING_COST_MARKUP` env binding, then no markup at
 * all — so a self-hoster who configures nothing pays the vendor's raw rate,
 * and the number that earns is the one the owner typed.
 */
export const billingConfig = sqliteTable("billing_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  // Set from the acting user when the change came through the admin area, so
  // an audit trail survives the row being overwritten. Null for a seed or a
  // migration, where there is no actor.
  updatedByUserId: text("updated_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(current_timestamp)`),
});
