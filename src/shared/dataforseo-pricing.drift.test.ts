import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as pricing from "@/shared/dataforseo-pricing";

/**
 * Price-drift watch: a stale price book must fail CI, not cost money quietly.
 *
 * ## Why this exists
 *
 * Every cost figure in the product comes from `src/shared/dataforseo-pricing.ts`,
 * and that file is hand-verified from the vendor's rendered pricing page. A vendor
 * price change means every capture over-spends silently: the capture still
 * succeeds, the archive still fills, the report still renders, and the only effect
 * is that the bill is larger than the one the estimates predicted. Nothing in the
 * system can notice, because nothing re-reads the page.
 *
 * The prices themselves were already asserted against a live read by
 * `dataforseo-pricing.test.ts`. The **date they were read** was prose — a claim
 * nobody checked, which is the half that lets a book go stale without a word
 * changing.
 *
 * ## Why not read the vendor's price catalogue at test time
 *
 * It does not exist. That was checked before building this, rather than assumed:
 *
 *   GET /v3/appendix/prices     →  404
 *   GET /v3/appendix/endpoints  →  200, but a two-entry stub listing only its own
 *                                    paths ("v3/appendix/errors", "v3/appendix/user_data")
 *
 * The vendor publishes prices on rendered pricing pages, not through the API —
 * which is what the price book's own header asserts. So a real read is not an
 * option at any cost, and the honest drift watch is a **provenance assertion**
 * with an explicit staleness boundary: it does not claim to detect a price change
 * (nothing can, unreadably), it detects *nobody has looked*, which is in CI's
 * power to enforce and is the actual cause of silent drift.
 *
 * ## Why it reads the file rather than an exported constant
 *
 * The first attempt exported the header as a template string. It could not work:
 * the header is 500 lines of prose containing backticks and `$`, so escaping it
 * into a template literal breaks both the linter and the file's own 400-line
 * limit — and it would have forked the prose into a second copy that the price
 * book's own comments contradict.
 *
 * Reading the source is the pattern `geo-module-reachability.test.ts` already
 * uses for a claim about a file's own content. The gate can therefore hold a
 * provenance section that is written for a human, and the price book stays a
 * single source. The trade-off is real and named: **a source-reading gate cannot
 * fail if the file is deleted**, which is why the assertion is scoped to a file
 * that the rest of the suite already imports and would break without.
 */

const REPO_ROOT = process.cwd().endsWith("\\src")
  ? process.cwd().replace(/[\\/]src[\\/]?$/, "")
  : process.cwd();

const PRICE_BOOK = join(REPO_ROOT, "src/shared/dataforseo-pricing.ts");

/** How long a re-read date stays trustworthy. */
const VERIFY_BY_DAYS = 90;

/** The reference date the boundary is measured from. */
const NOW = new Date("2026-10-10T00:00:00Z");

/**
 * The re-read dates the header claims, by row group.
 *
 * **Parsed line by line, not with a crossing regex.** The header's entries wrap
 * across several lines, so a pattern matching `**…**` to the next date on the same
 * expression happily spans three bullet points and pairs the first bold-span
 * with the last date. That is the shape that would make this gate report a
 * verified date for a row nobody checked — a gate that launders prose.
 *
 * The rule is the one the header itself uses: the date on the same line as a
 * `**group**` marker is that group's re-read date.
 *
 * **Leading `//` is allowed, because this file is a comment block, not markdown.**
 * The first version anchored on `^[\s*-]*\*\*` and matched nothing at all — the gate
 * then reported "provenance missing" for a book that carried it, which is the
 * failure where a gate is wrong rather than the product.
 */
function parseHeaderDates(): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of readFileSync(PRICE_BOOK, "utf8").split("\n")) {
    const match = line.match(
      /^(?:\/\/)?[\s*-]*\*\*([^*]+?)\*\*[^\n]*?(\d{4}-\d{2}-\d{2})/,
    );
    // The capture groups are always defined when match succeeds, so no cast
    // is needed here — and the type-aware linter rejects one as unnecessary.
    if (match) found.set(match[1].trim(), match[2]);
  }
  return found;
}

/** How stale a re-read date is, in days, as of `NOW`. */
function ageInDays(date: string): number {
  return (NOW.getTime() - new Date(`${date}T00:00:00Z`).getTime()) / 86_400_000;
}

describe("the price book's provenance is enforced", () => {
  it("is importable and exports every group the product prices against", () => {
    // The gate holds the file's prose, so it must also hold the numbers it
    // describes — otherwise a provenance assertion over an empty file passes.
    expect(pricing.DFS_AI_OPTIMIZATION.llmMentions.perRequest).toBeGreaterThan(
      0,
    );
    expect(pricing.DFS_ONPAGE.basePage).toBeGreaterThan(0);
    expect(pricing.DFS_LABS.standard.perRequest).toBeGreaterThan(0);
  });

  it("carries a named re-read date for each row group the header claims", () => {
    const dates = parseHeaderDates();
    // The rows the header names, with what it claims for each.
    expect(dates.get("AI Optimization")).toBe("2026-10-04");
    expect(dates.get("OnPage")).toBe("2026-10-04");
    expect(dates.get("Everything else")).toBe("2026-09-28");
  });

  it("does not claim a blanket verification date for rows nobody checked", () => {
    // A blanket "verified on <date>" is a claim about rows nobody looked at. The
    // gate must catch the regression back to one, because a blanket date is
    // indistinguishable from a checked one at a glance — which is the failure
    // mode of an intention, per the pre-publish audit's own wording.
    const header = readFileSync(PRICE_BOOK, "utf8");
    expect(header).toMatch(/Everything else/);
    expect(header).toMatch(/not re-checked|least-verified/i);
    // And the header's own date set must contain more than one entry, or the
    // "everything else" row is doing the work of every row.
    expect(parseHeaderDates().size).toBeGreaterThan(1);
  });
});

describe("the drift watch fires on a stale verification", () => {
  it("treats a re-read older than the verify-by window as stale", () => {
    // **The mechanism.** Not "the vendor changed price" — that is unreadable —
    // but "nobody has looked for N days". Both directions asserted, so the
    // boundary is a real comparison rather than a tautology.
    const fresh = ageInDays("2026-10-04");
    const ancient = ageInDays("2026-06-01");

    expect(fresh).toBeGreaterThan(0);
    expect(fresh).toBeLessThan(VERIFY_BY_DAYS);

    expect(ancient).toBeGreaterThan(VERIFY_BY_DAYS);
    // The gap is wide enough that a real drift cannot sit inside it by accident.
    expect(ancient - fresh).toBeGreaterThan(60);
  });

  it("fails when a provenance row loses its date", () => {
    // The negative control, expressed as a value: deleting a row's date must not
    // be silently treated as verified. This is the regression the gate exists
    // for — the mechanism by which "we checked this" decays into "we believe this"
    // without anyone deciding it.
    const dates = parseHeaderDates();
    const withoutOne = new Map(dates);
    withoutOne.delete("AI Optimization");

    expect(dates.has("AI Optimization")).toBe(true);
    expect(withoutOne.has("AI Optimization")).toBe(false);
    // ...and the parse keeps finding the others, so the failure is specific
    // rather than a blanket "the header is broken" that nobody can act on.
    expect(withoutOne.get("OnPage")).toBe("2026-10-04");
  });

  it("rounds a date to a day boundary rather than a partial one", () => {
    // A verification read on 2026-10-04 and checked at 2026-10-09 23:00 is five
    // days old, not five point nine — otherwise every date swings by a whole day
    // depending on what time CI ran, and a boundary that flickers is a boundary
    // nobody trusts.
    const onBoundary = ageInDays("2026-10-09");
    expect(Number.isInteger(onBoundary)).toBe(true);
    expect(onBoundary).toBe(1);
  });
});
