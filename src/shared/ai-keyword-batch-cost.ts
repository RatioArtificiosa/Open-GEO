/**
 * What one AI Keyword Data call costs, and how many calls a keyword count takes.
 *
 * ## Why this is a module and not part of the price table
 *
 * The table is **deliberately data, not logic** — its own header says so — and
 * the batch caveat once carried the arithmetic in prose. That prose went stale
 * twice: it read correctly long after one of the two rates beneath it had been
 * corrected by a factor of twenty. **Prose about prices fails silently**; a sum
 * that reads the rates cannot.
 *
 * ## The two fees are added, not multiplied
 *
 * DataForSEO bills a **request fee** plus a **per-item** fee, and a request
 * carries at most 1,000 keywords. So a full batch is **$0.11, not $0.10** — the
 * task fee is not amortised away by filling the batch, which is what makes a
 * full batch cost *more* per keyword than a hundred small ones.
 *
 * ## Why a caller gets this wrong
 *
 * Because the per-keyword rate alone is right for a *per-keyword* quote and
 * wrong for a *batch* — and at a full batch the request fee is **8% of the
 * total**, so the error is invisible until someone reconciles a bill.
 */
import { AI_KEYWORD_UNIT_COST_USD } from "./dataforseo-pricing";

/**
 * Keywords one AI Keyword Data request can carry.
 *
 * **A rejection above it rather than a truncation**, which is why the nightly
 * capture slices a project's list before posting rather than letting it run over.
 */
const AI_KEYWORD_BATCH_MAX = 1000;

/**
 * The per-**request** fee, USD — **added to** the per-keyword rate, never
 * multiplied by a keyword count.
 *
 * **It lives here because this is the only function that reads it.** A constant one
 * caller uses does not belong in a table forty callers read, and the price book's
 * own header asks that it stay data.
 *
 * A planner once wrote `calls * AI_KEYWORD_UNIT_COST_USD` and charged $0.0001 for a
 * 1,000-keyword batch the vendor bills at $0.11. Verified 2026-10-04.
 */
const AI_KEYWORD_TASK_FEE_USD = 0.01;

/** Module-private: every caller reads the value, none names the type. */
type AiKeywordBatchCost = {
  calls: number;
  perRequestUsd: number;
  perUnitUsd: number;
  totalUsd: number;
};

export function estimateAiKeywordBatch(keywords: number): AiKeywordBatchCost {
  // **Zero and below cost nothing.** An empty project should not bill a request.
  //
  // **A negative count is clamped rather than propagated**, because a caller
  // computing `someMax - someActual` can produce one, and
  // `Math.ceil(negative / 1000)` is a negative call count — which a budget loop
  // would read as *credit* and spend against.
  const positive = keywords > 0 ? keywords : 0;
  const calls = positive === 0 ? 0 : Math.ceil(positive / AI_KEYWORD_BATCH_MAX);
  const perRequestUsd = round(calls * AI_KEYWORD_TASK_FEE_USD);
  // **The 1,000 limit is per request, not per order.** A million keywords is
  // 1,000 requests of 1,000 each, and every request bills its per-item fee, so
  // the unit cost scales with the *order*. An earlier version capped it at one
  // batch, which priced a million keywords at $10 instead of $100 — **the worst
  // direction for an estimate**, because it under-reserves and the overspend
  // arrives as a surprise invoice.
  const perUnitUsd = round(positive * AI_KEYWORD_UNIT_COST_USD);
  return {
    calls,
    perRequestUsd,
    perUnitUsd,
    totalUsd: round(perRequestUsd + perUnitUsd),
  };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
