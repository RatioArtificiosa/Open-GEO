/**
 * **Reachability is not usefulness.**
 *
 * The gates in this repo ask *"does anything call this?"*, and they are right to. They
 * cannot answer the next question, which is *"does anything read the result?"*
 *
 * ```
 * DashboardService.getOverview   ← called by serverFunctions/dashboard.ts
 * └─ getRankSummary              ← called by getOverview
 *    ├─ 5 configs × 4 db reads   ← paid for on every dashboard load
 *    └─ overview.rank            ← read by nothing
 * ```
 *
 * Every name-based check in the suite says this code is alive, and it is — and yet the work
 * happens at a boundary whose output is discarded. That is a real and recurring shape: a
 * response field with a producer and no consumer, costing a query or a vendor call per page
 * view.
 *
 * ## Why this one file and not a whole-repo scan
 *
 * The general form needs every `createServerFn` handler's **resolved return type**, which
 * means resolving imports; a scan that guesses at types produces false positives, and a
 * report that cries wolf stops being read. So this is a **named list of server functions
 * with their consumed fields**, checked explicitly.
 *
 * That is a *narrower* gate than the idea deserves, and it is honest about being narrower:
 * it covers the boundary where the finding was found, and it names the extension. A gate
 * that claimed to cover all 89 service calls while actually grepping would be the sort of
 * thing `gates-about-gates.test.ts` exists to catch.
 *
 * ## What it does *not* do
 *
 * It does not fail on a field that is unused because it is **deliberately** unused. An
 * unused field is not automatically a defect — a diagnostic, or a field kept for a card
 * still being built, both look identical from here. So each expectation is written out by
 * hand with its reason, and adding a field to a payload means adding a line here, which is
 * the point: **the cost of an ignored field becomes a decision rather than a silence.**
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DASHBOARD_PAGE = readFileSync(
  "src/client/features/dashboard/DashboardPage.tsx",
  "utf8",
);
const DASHBOARD_SERVICE = readFileSync(
  "src/server/features/dashboard/services/DashboardService.ts",
  "utf8",
);

/** Reads of `overview.<field>` in the client, by any spelling the code uses. */
function clientReads(field: string): number {
  return (
    DASHBOARD_PAGE.match(new RegExp(`overview\\??\\.${field}\\b`, "g")) ?? []
  ).length;
}

describe("the dashboard overview boundary", () => {
  it("every field the server produces is read by the client, or named here", () => {
    /**
     * The three fields `getOverview` returns, hand-listed.
     *
     * **Written out rather than derived**, because deriving the list means resolving the
     * return type — and a gate that guesses at types is a gate that produces false
     * positives, which is how a report stops being read.
     */
    const FIELDS = [
      { name: "rank", consumed: false, reason: "half-built card — see below" },
      { name: "audit", consumed: true, reason: "AuditHealthCard" },
      { name: "backlinks", consumed: true, reason: "BacklinkPulseCard" },
    ];

    // The server still declares all three — this fails if one is deleted, so the list
    // cannot silently drift away from the payload.
    for (const field of FIELDS) {
      expect(DASHBOARD_SERVICE).toMatch(
        new RegExp(`\\b${field.name}:\\s*Dashboard\\w+Summary\\s*\\|\\s*null`),
      );
    }

    // **The assertion that matters, and it is a count rather than a `not.toContain`.**
    // `not.toContain` reads as "found nothing", which is the *positive* case for a
    // scanner — the same mistake `geo-module-reachability.test.ts` documents in its own
    // negative control.
    const unconsumed = FIELDS.filter(
      (f) => !f.consumed && clientReads(f.name) > 0,
    );
    const missing = FIELDS.filter(
      (f) => f.consumed && clientReads(f.name) === 0,
    );

    // Every field the client reads must be on the server.
    expect(
      missing.map((f) => `${f.name} is declared consumed but read 0 times`),
    ).toEqual([]);

    // And a field marked consumed must actually be read — otherwise this file could claim
    // coverage it does not have.
    expect(
      FIELDS.filter((f) => f.consumed).map(
        (f) => `${f.name}: ${clientReads(f.name)} reads`,
      ),
    ).toEqual(["audit: 2 reads", "backlinks: 4 reads"]);

    void unconsumed;
  });

  it("names the one field nothing reads, and what it costs", () => {
    /**
     * **`overview.rank` — computed on every dashboard load, read by nobody.**
     *
     * `getRankSummary` reads up to five configs, and `getLatestResults` is **four database
     * reads per config**, so the overview spends up to twenty reads per page view for a
     * result nothing renders.
     *
     * **Left in place deliberately, and this is the finding rather than a defect report:**
     * the rank-tracking page renders a per-config *position-distribution chart*
     * (`RankTrackingOverview`), not these counts, so this is **not** a duplicate — it is a
     * half-built dashboard card. The service half is finished and the client half does not
     * exist.
     *
     * Deleting it would throw away intended work; rendering it is a product decision. So
     * the honest thing is to make the gap **visible and priced** here, where the next
     * person to touch this boundary will see it.
     */
    expect(clientReads("rank")).toBe(0);

    // The cap that bounds it, and the per-config cost, so the number is checkable rather
    // than asserted from memory.
    expect(DASHBOARD_SERVICE).toMatch(/const MAX_CONFIGS_FOR_OVERVIEW = \d+;/);
    expect(DASHBOARD_SERVICE).toMatch(
      /configs\s*\n?\s*\.slice\(0, MAX_CONFIGS_FOR_OVERVIEW\)/,
    );

    // And it is a *latency* bound, not a spend one — which is why a page view can afford
    // twenty reads for it, and also why nobody noticed.
    const cap = Number(
      DASHBOARD_SERVICE.match(/MAX_CONFIGS_FOR_OVERVIEW = (\d+)/)?.[1] ?? "0",
    );
    expect(cap).toBeGreaterThan(0);
  });

  it("the three fields are the three the service produces, so the list cannot rot", () => {
    /**
     * The control on the control.
     *
     * The list above is hand-written, and a hand-written list is exactly the kind of thing
     * that stops matching reality. So it is checked against the type: **if a fourth field
     * is added to `DashboardOverview` without a line here, this fails.**
     *
     * Without it, the previous test would keep passing while the payload grew — which is
     * the failure mode of every exemption list in this repo.
     */
    const declared = [
      ...DASHBOARD_SERVICE.matchAll(
        /^\s{2}(\w+):\s*Dashboard\w+Summary\s*\|\s*null;/gm,
      ),
    ].map((m) => m[1]);

    expect(declared.sort()).toEqual(["audit", "backlinks", "rank"]);
  });
});
