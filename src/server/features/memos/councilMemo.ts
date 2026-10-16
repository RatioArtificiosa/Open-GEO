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

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * Render the memo.
 *
 * At most three fixes, highest-impact first — fixes without an impact figure
 * sort after fixes with one, because an unestimated fix ranked above an
 * estimated one would be a guess wearing priority's clothes. Surplus fixes
 * are dropped with the count stated, not silently.
 */
export function renderCouncilMemo(input: CouncilMemoInput): string {
  const lines: string[] = [
    `# GEO Council Memo — ${input.brand}`,
    `_${input.periodFrom} to ${input.periodTo}. Every number below was measured in this window._`,
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
      lines.push(`- ${change.subject} ${change.direction} ${count} citations.`);
    }
  }
  lines.push(``, `## What it means`);
  const gained = input.citationChanges.filter(
    (c) => c.direction === "gained",
  ).length;
  const lost = input.citationChanges.filter(
    (c) => c.direction === "lost",
  ).length;
  if (gained === 0 && lost === 0) {
    lines.push(
      `Nothing to interpret yet — interpretation without movement is narrative.`,
    );
  } else if (lost > gained) {
    lines.push(
      `More ground lost than gained (${lost} lost, ${gained} gained). The fix list below is ordered by expected impact, not by comfort.`,
    );
  } else {
    lines.push(
      `Net positive (${gained} gained, ${lost} lost). Hold the gains first — the fixes below protect what moved before chasing what did not.`,
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
        `${index + 1}. ${fix.action} — ${fix.reason}${fix.impact === null ? " (impact unestimated)" : ` (expected impact: ${fix.impact})`}`,
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
