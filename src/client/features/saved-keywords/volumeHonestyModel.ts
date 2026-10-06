/**
 * Display rules for the volume-honesty panel.
 *
 * Pure and separate from the component so the wording and the badge for each verdict are
 * testable, and so the same four verdicts cannot be described two different ways in two places.
 *
 * ## The tone is honest about which states are bad
 *
 * `measured-higher` and `measured-lower` are **not errors**: nothing is broken, and both are
 * normal consequences of how Google Ads reports volume. They are `warning` because the shown
 * figure is unconfirmed, not because the customer or the product did anything wrong. Reading
 * them as failures would push a reader toward "fixing" a number that is simply an estimate.
 */

type VerdictTone = "ok" | "warn" | "muted";

type VerdictBadge = {
  label: string;
  tone: VerdictTone;
  /** daisyUI classes, kept here so every surface renders a verdict the same way. */
  className: string;
  /** One short sentence, for a tooltip or a table cell. */
  hint: string;
};

/** The fallback, named, so "not checked" reads as a deliberate answer rather than a default. */
const UNCHECKED_BADGE: VerdictBadge = {
  label: "Not checked",
  tone: "muted",
  className: "bg-base-300 text-base-content/70",
  hint: "One side had no figure, so nothing can be said about this keyword in this market.",
};

const VERDICT_BADGES: Record<string, VerdictBadge> = {
  corroborated: {
    label: "Corroborated",
    tone: "ok",
    className: "bg-success/20 text-success",
    hint: "The measured figure agrees with the one we show.",
  },
  "measured-higher": {
    label: "Measured higher",
    tone: "warn",
    className: "bg-warning/20 text-warning",
    hint: "The measured figure is higher, which usually means ours inherited a grouped estimate's total.",
  },
  "measured-lower": {
    label: "Measured lower",
    tone: "warn",
    className: "bg-warning/20 text-warning",
    hint: "The measured figure is lower, which usually means ours came from a cluster this keyword does not belong to.",
  },
  uncomparable: UNCHECKED_BADGE,
};

/** An unrecognised verdict is displayed as unchecked rather than dressed up as a result. */
export function verdictBadge(verdict: string): VerdictBadge {
  return VERDICT_BADGES[verdict] ?? UNCHECKED_BADGE;
}

/** Thousands-separated, or an em dash when there is no figure. Zero is a real number. */
export function formatVolume(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-US").format(value);
}

/**
 * The sentence above the table.
 *
 * It leads with the share of *comparable* keywords that agreed, and names the unchecked ones
 * separately, because folding them in either direction would misstate the result: as agreement
 * it flatters, as disagreement it invents a finding.
 */
export function reconciliationHeadline(summary: {
  total: number;
  corroborated: number;
  uncomparable: number;
  corroborationRate: number | null;
}): string {
  const comparable = summary.total - summary.uncomparable;
  if (summary.corroborationRate === null || comparable === 0) {
    return "No volume could be checked: every keyword was missing a figure on one side.";
  }
  const percent = Math.round(summary.corroborationRate * 100);
  return `${summary.corroborated} of ${comparable} comparable keyword${comparable === 1 ? "" : "s"} (${percent}%) have a volume the measured data supports.`;
}
