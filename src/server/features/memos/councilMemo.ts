/**
 * Weekly GEO Council Memo engine (CL-508): what changed, what it means, top-3
 * fixes, impact, cost — rendered from data the product already keeps.
 *
 * A memo that invents good news is worse than no memo, so every section has
 * an explicit empty state: unwatched inputs are reported as unmeasured (never
 * as good), unpriced fixes carry no impact figure (never zero), and every
 * number travels with the period it was measured over. The memo is markdown
 * text, branded by the caller — this module owns the honesty, not the theme.
 *
 * Pure: all reads arrive as arguments. The scheduler and the white-label
 * wrapper live outside this file.
 */

import { dayKey, parseCalendarDate } from "@/server/lib/calendarDate";

export type MemoCitationChange = {
  subject: string;
  direction: "gained" | "lost";
  /** Citations gained or lost; null when the delta is unmeasured. */
  count: number | null;
};

export type MemoFix = {
  action: string;
  reason: string;
  /** Expected impact, or null when unestimated — never zero as a guess. */
  impact: string | null;
};

export type CouncilMemoInput = {
  brand: string;
  /** ISO dates bounding every number in the memo. */
  periodFrom: string;
  periodTo: string;
  citationChanges: MemoCitationChange[];
  topFixes: MemoFix[];
  /** Vendor spend over the period, USD, or null when unmetered. */
  spendUsd: number | null;
  /** Forecasts scored since the last memo, or null when none were kept. */
  forecastsScored: number | null;
};

/**
 * Caller strings enter markdown — escape them.
 *
 * Brand, subject, action, reason, and impact arrive from the caller, and
 * an unescaped newline forges a section while raw HTML rides into
 * HTML-capable Markdown consumers as markup. Newlines become spaces,
 * HTML metacharacters become entities, Markdown metacharacters take a
 * backslash. Our own literals (headings, counts, money) stay literal —
 * only caller input passes through here.
 */
function memoText(value: string): string {
  const flat = value.replaceAll("\r", " ").replaceAll("\n", " ");
  const html = flat
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const specials = [
    "\\",
    "`",
    "*",
    "_",
    "{",
    "}",
    "[",
    "]",
    "(",
    ")",
    "#",
    "+",
    "!",
    "|",
    "~",
  ];
  let out = html;
  for (const char of specials) {
    out = out.split(char).join(`\\${char}`);
  }
  return out;
}

/** A memo without a real window is a narrative — refuse it up front. */
function assertPeriod(periodFrom: string, periodTo: string): void {
  const from = parseCalendarDate(periodFrom);
  const to = parseCalendarDate(periodTo);
  if (from === null || to === null || dayKey(to) < dayKey(from)) {
    throw new Error(
      `council memo needs a real period (yyyy-mm-dd, from at most to), got "${periodFrom}" to "${periodTo}"`,
    );
  }
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * Render the memo.
 *
 * At most three fixes in the caller's ranked order (highest-impact first —
 * the caller ranks, the renderer preserves; impact is prose, not a number,
 * so no ordering is computable here). Fixes without an impact figure sort
 * after fixes with one, because an unestimated fix ranked above an
 * estimated one would be a guess wearing priority's clothes. Surplus fixes
 * are dropped with the count stated, not silently.
 */
export function renderCouncilMemo(input: CouncilMemoInput): string {
  assertPeriod(input.periodFrom, input.periodTo);
  const lines: string[] = [
    `# GEO Council Memo — ${memoText(input.brand)}`,
    `_${memoText(input.periodFrom)} to ${memoText(input.periodTo)}. Every number below was measured in this window._`,
    ``,
    `## What changed`,
  ];
  if (input.citationChanges.length === 0) {
    lines.push(
      `No citation movements recorded this period — unwatched, not calm.`,
    );
  } else {
    for (const change of input.citationChanges) {
      const count =
        change.count === null
          ? "an unmeasured number of"
          : String(change.count);
      lines.push(
        `- ${memoText(change.subject)} ${change.direction} ${count} citations.`,
      );
    }
  }
  lines.push(``, `## What it means`);
  // Net movement is citations, not records: one gained record and one lost
  // record can hide forty lost citations. Null counts are unmeasured —
  // excluded from the totals with the count stated, never treated as zero.
  const gainedRecords = input.citationChanges.filter(
    (c) => c.direction === "gained",
  );
  const lostRecords = input.citationChanges.filter(
    (c) => c.direction === "lost",
  );
  const gainedTotal = gainedRecords.reduce((sum, c) => sum + (c.count ?? 0), 0);
  const lostTotal = lostRecords.reduce((sum, c) => sum + (c.count ?? 0), 0);
  const unmeasured = input.citationChanges.filter(
    (c) => c.count === null,
  ).length;
  const unmeasuredClause =
    unmeasured === 0
      ? ""
      : ` ${unmeasured} record(s) moved by unmeasured amounts — the verdict above covers measured movement only.`;
  if (gainedRecords.length === 0 && lostRecords.length === 0) {
    lines.push(
      `Nothing to interpret yet — interpretation without movement is narrative.`,
    );
  } else if (lostTotal > gainedTotal) {
    lines.push(
      `More ground lost than gained (${lostTotal} citations lost, ${gainedTotal} gained). The fix list below is ordered by expected impact, not by comfort.${unmeasuredClause}`,
    );
  } else if (gainedTotal > lostTotal) {
    lines.push(
      `Net positive (${gainedTotal} citations gained, ${lostTotal} lost). Hold the gains first — the fixes below protect what moved before chasing what did not.${unmeasuredClause}`,
    );
  } else if (unmeasured > 0) {
    lines.push(
      `Movement recorded but unmeasured in ${unmeasured} record(s) — no measured delta either way, so no verdict.`,
    );
  } else {
    lines.push(
      `Dead even (${gainedTotal} citations each way). Parity is not progress — the fix list below still applies.`,
    );
  }
  lines.push(``, `## Top fixes`);
  const withImpact = input.topFixes.filter((fix) => fix.impact !== null);
  const withoutImpact = input.topFixes.filter((fix) => fix.impact === null);
  const ranked = [...withImpact, ...withoutImpact].slice(0, 3);
  if (ranked.length === 0) {
    lines.push(`No fixes proposed — an empty list, not an all-clear.`);
  } else {
    ranked.forEach((fix, index) => {
      lines.push(
        `${index + 1}. ${memoText(fix.action)} — ${memoText(fix.reason)}${fix.impact === null ? " (impact unestimated)" : ` (expected impact: ${memoText(fix.impact)})`}`,
      );
    });
    if (input.topFixes.length > 3) {
      lines.push(
        `_${input.topFixes.length - 3} further fix(es) below the top three._`,
      );
    }
  }
  lines.push(``, `## Impact and cost`);
  lines.push(
    input.spendUsd === null
      ? `Spend unmetered this period — cost unknown, not zero.`
      : `Vendor spend this period: ${money(input.spendUsd)}.`,
  );
  lines.push(
    input.forecastsScored === null
      ? `No kept forecasts to score since the last memo.`
      : `${input.forecastsScored} kept forecast(s) scored against reality.`,
  );
  return lines.join("\n");
}
