import { describe, expect, it, vi } from "vitest";

/**
 * The readiness report's read/write rules, tested as pure functions.
 *
 * **The parsers are the rules.** The save path is one upsert whose correctness
 * rests on the deterministic id, and the read path is `null` versus `[]` versus a
 * parsed list — which is where the distinctions this project keeps insisting on
 * actually live. Testing the query builder would test Drizzle.
 */
vi.mock("cloudflare:workers", () => ({ env: {} }));

import { parseStoredReadiness } from "./auditReadinessReports.parse";

/**
 * The fix shape, written out locally.
 *
 * **Declared here rather than imported**, because the module keeps its own types
 * private and a test reaching in to force an export would widen a module's API for
 * its own convenience. Declaring the shape independently is also a real check: if
 * the parser's shape drifts from what a stored fix actually looks like, this
 * fixture stops typechecking.
 */
type StoredReadinessFix = {
  id: string;
  kind: string;
  fix: string;
  because: string;
  example: string | null;
  order: number;
};

const FIX: StoredReadinessFix = {
  id: "crawler-blocked",
  kind: "switch",
  fix: "Allow GPTBot in robots.txt",
  because: "nothing else works until agents can read the site",
  example: null,
  order: 0,
};

describe("parseStoredReadiness", () => {
  it("reads a stored report with its fix order intact", () => {
    const parsed = parseStoredReadiness({
      id: "r1",
      auditId: "a1",
      summary: "One thing first.",
      whyNoScore:
        "A blocked crawler and perfect content average to a healthy middle.",
      fixesJson: JSON.stringify([FIX]),
      coverageJson: JSON.stringify(["robots.txt was read"]),
      unavailableJson: JSON.stringify([]),
      fixCount: 1,
      pageCount: 3,
      createdAt: "2026-10-04T00:00:00.000Z",
    });

    expect(parsed?.fixes).toEqual([FIX]);
    expect(parsed?.coverage).toEqual(["robots.txt was read"]);
  });

  it("returns null for a missing row", () => {
    // **Distinct from an empty report.** A missing row says our run did not
    // finish; an empty `fixes` says it finished and found nothing. A reader that
    // collapses them tells a customer their site is fine because we crashed.
    expect(parseStoredReadiness(null)).toBeNull();
  });

  it("reports an empty fix list as a clean audit, not a missing one", () => {
    const parsed = parseStoredReadiness({
      id: "r1",
      auditId: "a1",
      summary: "Nothing to fix.",
      whyNoScore: "There is deliberately no overall number.",
      fixesJson: "[]",
      coverageJson: "[]",
      unavailableJson: "[]",
      fixCount: 0,
      pageCount: 5,
      createdAt: "2026-10-04T00:00:00.000Z",
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.fixes).toEqual([]);
    expect(parsed?.fixCount).toBe(0);
    // Coverage `[]` is a real answer and must survive the round trip.
    expect(parsed?.coverage).toEqual([]);
  });

  it("reports a corrupt coverage column as null, not as an empty list", () => {
    // **The distinction the whole null convention exists for.** `[]` means *we
    // checked everything and it covered nothing*; a column we cannot read means
    // *we do not know*. The report's `whyNoScore` leans on the difference.
    const parsed = parseStoredReadiness({
      id: "r1",
      auditId: "a1",
      summary: "s",
      whyNoScore: "w",
      fixesJson: "[]",
      coverageJson: "{not json",
      unavailableJson: "[]",
      fixCount: 0,
      pageCount: 1,
      createdAt: "2026-10-04T00:00:00.000Z",
    });

    expect(parsed?.coverage).toBeNull();
  });

  it("reports a corrupt fixes column as an empty list, since an unreadable list cannot be trusted", () => {
    // **Asymmetric on purpose.** Fixes are the report's content, and a corrupt
    // blob there is a write we cannot recover — an empty list is the honest
    // "nothing I can show you". Coverage is different: the *absence* of it is
    // itself information, so it stays null.
    const parsed = parseStoredReadiness({
      id: "r1",
      auditId: "a1",
      summary: "s",
      whyNoScore: "w",
      fixesJson: "][",
      coverageJson: "[]",
      unavailableJson: "[]",
      fixCount: 0,
      pageCount: 1,
      createdAt: "2026-10-04T00:00:00.000Z",
    });

    expect(parsed?.fixes).toEqual([]);
  });

  it("drops a fix missing the words a reader needs, rather than half-rendering it", () => {
    // **A fix is rendered verbatim.** An entry with no `fix` or no `because` is
    // not a degraded row — it renders as an empty instruction with no reason
    // attached, which is worse than absent because it *looks* actionable.
    const parsed = parseStoredReadiness({
      id: "r1",
      auditId: "a1",
      summary: "s",
      whyNoScore: "w",
      fixesJson: JSON.stringify([
        {
          id: "good",
          kind: "switch",
          fix: "Allow GPTBot",
          because: "nothing else works",
          order: 0,
        },
        {
          id: "no-fix",
          kind: "switch",
          because: "a reason with no instruction",
          order: 1,
        },
        {
          id: "no-because",
          kind: "switch",
          fix: "an instruction with no reason",
          order: 2,
        },
      ]),
      coverageJson: "[]",
      unavailableJson: "[]",
      fixCount: 3,
      pageCount: 1,
      createdAt: "2026-10-04T00:00:00.000Z",
    });

    expect(parsed?.fixes.map((f) => f.id)).toEqual(["good"]);
  });

  it("keeps a whole coverage list null if any entry is unreadable", () => {
    // **Asymmetric with the fixes above, on purpose.** Dropping the bad line would
    // *understate* how much was checked — telling a reader less was verified than
    // the run actually recorded. Null says "we cannot tell", which is the truth.
    const parsed = parseStoredReadiness({
      id: "r1",
      auditId: "a1",
      summary: "s",
      whyNoScore: "w",
      fixesJson: "[]",
      coverageJson: JSON.stringify(["robots.txt was read", 42]),
      unavailableJson: "[]",
      fixCount: 0,
      pageCount: 1,
      createdAt: "2026-10-04T00:00:00.000Z",
    });

    expect(parsed?.coverage).toBeNull();
  });

  it("still preserves a genuinely empty coverage list as empty, not null", () => {
    // The counterpart: an empty list *is* a real answer, and turning it into null
    // would claim we could not read a column we read perfectly.
    const parsed = parseStoredReadiness({
      id: "r1",
      auditId: "a1",
      summary: "s",
      whyNoScore: "w",
      fixesJson: "[]",
      coverageJson: "[]",
      unavailableJson: "[]",
      fixCount: 0,
      pageCount: 1,
      createdAt: "2026-10-04T00:00:00.000Z",
    });

    expect(parsed?.coverage).toEqual([]);
  });

  it("preserves the fix order rather than re-sorting it", () => {
    // The ordering is the report's claim — a blocked crawler outranks everything
    // because it is a precondition. Re-sorting on read would quietly discard it.
    const ordered = [
      { ...FIX, id: "first", order: 0 },
      { ...FIX, id: "second", order: 1 },
    ];

    const parsed = parseStoredReadiness({
      id: "r1",
      auditId: "a1",
      summary: "s",
      whyNoScore: "w",
      // Stored deliberately out of `order` sequence.
      fixesJson: JSON.stringify([ordered[1], ordered[0]]),
      coverageJson: "[]",
      unavailableJson: "[]",
      fixCount: 2,
      pageCount: 1,
      createdAt: "2026-10-04T00:00:00.000Z",
    });

    expect(parsed?.fixes.map((f) => f.id)).toEqual(["second", "first"]);
  });
});
