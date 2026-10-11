import { eq } from "drizzle-orm";

import { db } from "@/db";
import { billingConfig } from "@/db/schema";
import { AppError } from "@/server/lib/errors";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";

/**
 * The hosted markup multiplier, and the only place it is decided.
 *
 * ## What this replaces, and why it had to go
 *
 * The markup used to be the literal `SEO_DATA_COST_MARKUP = 1.28` in
 * `src/shared/billing.ts`. `src/shared/` is bundled for the browser, so the
 * platform's margin shipped in **three** places at once: the public GitHub
 * source, the client JavaScript any hosted customer can read out of devtools,
 * and the website's own copy of the same number. Removing it from the website
 * alone would have changed none of that.
 *
 * ## Why it cannot be a constant at all
 *
 * The multiplier is a business dial, not a fact about the world. It moves when
 * we negotiate volume pricing, when the market allows more, and whenever the
 * vendor reprices. A published rate is therefore a promise we will break, and
 * the strategy already names what happens then: the moment a page asserts
 * something a reader can check and find false, the rest of the evidence on
 * that page stops working. So the value is read at request time, from
 * configuration, and never written into a bundle.
 *
 * ## Resolution order
 *
 * 1. **This operator's row** in `billing_config` — set in the admin area,
 *    effective immediately, no deploy.
 * 2. **`BILLING_COST_MARKUP`** — the deploy-time setting, which is what a
 *    self-hoster configures if they want a margin at all.
 * 3. **No markup.** The multiplier is 1, the raw vendor rate passes through
 *    unchanged.
 *
 * The default earns nothing on purpose. A self-hoster who configures
 * nothing should pay DataForSEO exactly what DataForSEO charges, and the
 * number that earns belongs to the person who typed it rather than to a
 * literal in an MIT-licensed repository.
 *
 * ## Self-host
 *
 * **Nothing in this file decides who is billed.** `applyCostMarkup` is a
 * pure function of its arguments, and the callers that display or deduct a
 * cost are the ones that know which auth mode they are in. Self-hosted
 * deployments must pass 1 (or never call this) — the raw rate is the honest
 * number there, and a markup applied to a customer who pays the vendor
 * directly would be charging twice.
 */
export const COST_MARKUP_CONFIG_KEY = "cost_markup";

/** The deploy-time knob. Names and comments only belong in `.env.example`. */
export const COST_MARKUP_ENV_VAR = "BILLING_COST_MARKUP";

/**
 * No markup: the raw vendor rate, unchanged.
 *
 * The fallback is 1 rather than a remembered 1.28 because a default that
 * earns money is a margin nobody chose, sitting in the one repository that
 * is MIT-licensed and mirrored publicly.
 */
export const NO_MARKUP = 1;

/**
 * A multiplier must be a finite number strictly above zero. Zero or negative
 * would make every hosted operation free or negative — a silent revenue hole
 * rather than a mispriced one — and a non-finite value turns a credit
 * arithmetic `Math.ceil` into `NaN` deductions.
 */
export function parseCostMarkup(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Apply the multiplier and round on the same scale every other billing
 * figure uses, so a marked-up cost and a raw cost are comparable to the
 * cent-fraction the credit conversion then multiplies.
 */
export function applyCostMarkup(rawUsd: number, markup: number): number {
  return Math.round(rawUsd * markup * 100000) / 100000;
}

/**
 * The operator's override, or null when the dial has never been turned.
 *
 * A read failure is surfaced rather than swallowed: a markup that silently
 * stops applying because a table read timed out is a charge that never
 * happened, which is the one failure mode this whole design exists to avoid.
 * The caller decides whether a missing table is fatal — see
 * `getConfiguredCostMarkupOverride`.
 */
export async function getConfiguredCostMarkupOverride(): Promise<
  number | null
> {
  const rows = await db
    .select({ value: billingConfig.value })
    .from(billingConfig)
    .where(eq(billingConfig.key, COST_MARKUP_CONFIG_KEY))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const parsed = parseCostMarkup(row.value);
  if (parsed === null) {
    throw new AppError(
      "INTERNAL_ERROR",
      `billing_config.${COST_MARKUP_CONFIG_KEY} is not a usable multiplier: ${JSON.stringify(row.value)}`,
    );
  }
  return parsed;
}

/**
 * Write the operator's override. `null` clears it, which hands control back
 * to the env binding — the documented escape from a value that was set wrong.
 */
export async function setConfiguredCostMarkupOverride(args: {
  markup: number | null;
  updatedByUserId?: string;
}): Promise<void> {
  const markup = args.markup;
  if (markup !== null && parseCostMarkup(String(markup)) === null) {
    throw new AppError(
      "VALIDATION_ERROR",
      `The markup must be a number above zero, received ${JSON.stringify(markup)}`,
    );
  }
  if (markup === null) {
    await db
      .delete(billingConfig)
      .where(eq(billingConfig.key, COST_MARKUP_CONFIG_KEY));
    return;
  }
  await db
    .insert(billingConfig)
    .values({
      key: COST_MARKUP_CONFIG_KEY,
      value: String(markup),
      updatedByUserId: args.updatedByUserId ?? null,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: billingConfig.key,
      set: {
        value: String(markup),
        updatedByUserId: args.updatedByUserId ?? null,
        // **Set it here too, or it only ever holds the insert time.** A column
        // default runs on INSERT and never on the UPDATE half of an upsert, so
        // an audit row that records who changed the markup would keep saying
        // when it was first created. The same mistake in a log line is a
        // timestamp that never moves; in a billing audit trail it is a row
        // that lies about when the margin was changed.
        updatedAt: nowIso(),
      },
    });
}

/**
 * An ISO-8601 UTC timestamp, matching how both dialects store `updated_at`.
 *
 * Passed in from the application rather than left to a SQL default, because a
 * default does not fire on the UPDATE half of an upsert — which is exactly
 * where this column is needed.
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Resolve the multiplier for this request.
 *
 * The env binding is read through `getOptionalEnvValue` so `process.env` (dev,
 * `.env.local`) wins over the Workers binding exactly as it does everywhere
 * else in the server.
 */
export async function resolveCostMarkup(): Promise<number> {
  const override = await getConfiguredCostMarkupOverride();
  if (override !== null) return override;
  const fromEnv = parseCostMarkup(
    await getOptionalEnvValue(COST_MARKUP_ENV_VAR),
  );
  if (fromEnv !== null) return fromEnv;
  return NO_MARKUP;
}

/**
 * Where the current multiplier came from, for the admin surface and for
 * support. "which dial is live" is the first question when an invoice looks
 * wrong, and answering it by reading three sources in a shell is not an
 * answer.
 */
export async function describeCostMarkup(): Promise<{
  markup: number;
  source: "operator" | "environment" | "default";
}> {
  const override = await getConfiguredCostMarkupOverride();
  if (override !== null) return { markup: override, source: "operator" };
  const fromEnv = parseCostMarkup(
    await getOptionalEnvValue(COST_MARKUP_ENV_VAR),
  );
  if (fromEnv !== null) return { markup: fromEnv, source: "environment" };
  return { markup: NO_MARKUP, source: "default" };
}
