/**
 * The two shared log formatters.
 *
 * **This file exists because one of three cron log lines printed a money figure
 * with no currency symbol** — a defect that existed only *between* three sibling
 * lines, so no check and no one-at-a-time reading could find it. Now the `$` is
 * written once, and a fourth capture inherits the format rather than reproducing it.
 */
import { describe, expect, it } from "vitest";
import {
  formatCaptureCost,
  formatDropped,
  type CaptureCostReport,
} from "@/server/features/geo/services/captureReport";

const report = (over: Partial<CaptureCostReport> = {}): CaptureCostReport => ({
  projectsVisited: 3,
  actualCostUsd: 0.0031,
  estimatedCostUsd: 0.004,
  ...over,
});

describe("formatCaptureCost", () => {
  it("prints both figures, each with a currency sign", () => {
    const line = formatCaptureCost(report());

    expect(line).toBe("vendor $0.0031 (est. $0.0040)");
    // **The `$` is the assertion.** The ETV line omitted it while its two siblings
    // had it, so a regression here reintroduces exactly that defect.
    expect(line.match(/\$/g)).toHaveLength(2);
  });

  it("shows the drift when the vendor disagrees with the estimate", () => {
    // The reason both numbers appear: a single figure would have to be the
    // measurement or the estimate, and either choice loses the comparison that
    // makes a repriced endpoint visible on the first night.
    const drift = formatCaptureCost(
      report({ actualCostUsd: 0.012, estimatedCostUsd: 0.002 }),
    );
    expect(drift).toContain("$0.0120");
    expect(drift).toContain("(est. $0.0020)");
  });

  it("shows two equal figures without pretending they differ", () => {
    // A match is a finding too — it says the price book is current — so it must not
    // be dressed up as a discrepancy.
    expect(formatCaptureCost(report({ actualCostUsd: 0.004 }))).toBe(
      "vendor $0.0040 (est. $0.0040)",
    );
  });

  it("rounds to four places, because a raw float is unreadable in a log", () => {
    expect(formatCaptureCost(report({ actualCostUsd: 0.00314159 }))).toContain(
      "$0.0031",
    );
  });
});

describe("formatDropped", () => {
  it("names dropped work, so a bounded run cannot read as a complete one", () => {
    expect(formatDropped(7)).toBe(", 7 dropped for budget");
  });

  it("prints nothing at zero rather than a zero", () => {
    // "We captured everything" and "we captured what we could afford" are different
    // claims, and only one is safe to repeat from a log. A `0 dropped` reads as a
    // measurement; silence reads as "nothing was dropped", which is the claim a
    // reader will make anyway.
    expect(formatDropped(0)).toBe("");
  });

  it("prints nothing for a negative count, rather than a nonsensical one", () => {
    // Unreachable from the runners, and the defensive branch costs nothing — but a
    // negative would be a claim that work was un-dropped, which is nonsense.
    expect(formatDropped(-1)).toBe("");
  });
});
