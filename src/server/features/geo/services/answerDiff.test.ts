import { describe, expect, it } from "vitest";
import { diffAnswers, type DiffAnswer } from "./answerDiff";

/**
 * The answer diff.
 *
 * The tests are mostly about **not inventing change**. A diff's failure mode is
 * symmetric and quiet: report a gain that did not happen and the customer
 * celebrates a page that was always there; report a loss that did not happen and
 * they rewrite something that was working. Both read as findings, so neither is
 * caught by a reader skimming.
 */

const answer = (
  id: string,
  answeredAt: string,
  citations: Array<[string, number]>,
): DiffAnswer => ({
  id,
  answeredAt,
  citations: citations.map(([url, rank]) => ({ url, rank })),
});

const A = answer("a1", "2026-03-12T00:00:00Z", [
  ["https://hubspot.com/x", 1],
  ["https://acme.com/pricing", 2],
  ["https://reddit.com/r/1", 3],
]);

/**
 * The "after" answer for the headline test.
 *
 * The customer's page moves 2 → 1 and the competitor's is gone, which is the
 * proposal's own example. The customer did not *gain* the page: it was already
 * cited, it just moved up. A diff that reported that as a gain would let a
 * customer celebrate a position they had held for a week.
 */
const B = answer("a2", "2026-03-19T00:00:00Z", [
  ["https://acme.com/pricing", 1],
  ["https://reddit.com/r/1", 2],
]);

describe("diffAnswers", () => {
  it("reports the drop and the two moves, losses first", () => {
    // The proposal's own example: HubSpot was cited, then it was not, and the
    // customer was. A regression outranks an opportunity, so it leads.
    //
    // The customer did not *gain* their page — it was already cited and only
    // moved from 2 to 1. A diff reporting that as a gain would let someone
    // celebrate a position they had held for a week.
    const diff = diffAnswers({ prompt: "best CRMs", before: A, after: B });
    expect(diff.changes.map((c) => c.kind)).toEqual(["lost", "moved", "moved"]);
    expect(diff.changes[0]).toMatchObject({
      kind: "lost",
      url: "hubspot.com/x",
    });
    expect(diff.changes[1]).toMatchObject({
      kind: "moved",
      url: "acme.com/pricing",
      from: 2,
      to: 1,
    });
    expect(diff.summary).toMatch(/1 citation dropped/i);
    expect(diff.summary).toMatch(/2 changed position/i);
  });

  it("does not call a re-parameterised URL a change", () => {
    // The single most valuable property here. `?utm_source=openai` is in the
    // documented payloads, so two runs of the same answer routinely differ only
    // by a tracking parameter. Without normalisation every run reports the same
    // page gained and lost, and the diff is noise the customer learns to ignore.
    //
    // The "after" keeps all three of the original citations so the only changes
    // are the two rank moves — isolating tracking from a genuine drop, which the
    // headline test already covers.
    const withTracker = answer("a2", "2026-03-19T00:00:00Z", [
      ["https://hubspot.com/x?utm_source=openai", 1],
      ["https://acme.com/pricing?utm_source=openai", 1],
      ["https://reddit.com/r/1?utm_source=openai#top", 2],
    ]);
    const diff = diffAnswers({
      prompt: "best CRMs",
      before: A,
      after: withTracker,
    });
    expect(diff.changes).toEqual([
      { kind: "moved", url: "acme.com/pricing", from: 2, to: 1 },
      { kind: "moved", url: "reddit.com/r/1", from: 3, to: 2 },
    ]);
  });

  it("calls a stable answer a finding, not an absence", () => {
    // "Nothing changed" is what a customer is paying for. An empty changes list
    // with no sentence is indistinguishable from "we did not run the diff".
    const diff = diffAnswers({ prompt: "best CRMs", before: A, after: A });
    expect(diff.changes).toEqual([]);
    expect(diff.summary).toMatch(/the answer is stable/i);
  });

  it("refuses answers given in the wrong order", () => {
    // Sorting them here would hide a caller bug. Passing them reversed inverts
    // every gain into a loss — plausible, and completely wrong.
    expect(() =>
      diffAnswers({ prompt: "best CRMs", before: B, after: A }),
    ).toThrow(/reverse order/i);
  });

  it("always says it does not know why an answer changed", () => {
    // Models change for reasons we cannot observe. Presenting a citation change
    // as the consequence of what the customer did last week is a causal claim
    // with no evidence, and it is how a customer blames their own content.
    const diff = diffAnswers({ prompt: "best CRMs", before: A, after: B });
    expect(diff.caveat).toMatch(/does not show why/i);
    expect(diff.caveat).toMatch(/cannot observe/i);
  });

  it("does not report a change for a URL it cannot identify", () => {
    // A malformed URL on one side only would otherwise be a phantom gain and
    // loss. We report fewer changes rather than invented ones.
    const broken = answer("a2", "2026-03-19T00:00:00Z", [
      ["not a url", 1],
      ["https://acme.com/pricing", 1],
    ]);
    const diff = diffAnswers({ prompt: "q", before: A, after: broken });
    expect(diff.changes.map((c) => c.url)).not.toContain("not a url");
  });

  it("treats a citation with no rank as its position in the list", () => {
    // The provider usually gives a rank; when it does not, list order is the only
    // position signal available, and inventing a rank of 0 would put it first.
    const noRank: DiffAnswer = {
      id: "a1",
      answeredAt: "2026-03-12T00:00:00Z",
      citations: [{ url: "https://acme.com/pricing", rank: null }],
    };
    const after: DiffAnswer = {
      id: "a2",
      answeredAt: "2026-03-19T00:00:00Z",
      citations: [
        { url: "https://acme.com/pricing", rank: null },
        { url: "https://hubspot.com/x", rank: 1 },
      ],
    };
    const diff = diffAnswers({ prompt: "q", before: noRank, after });
    expect(diff.changes).toEqual([
      { kind: "gained", url: "hubspot.com/x", rank: 1 },
    ]);
  });

  it("handles an answer going from no citations to some", () => {
    // 0 → 2 is a real change even though every citation is new, and it is the
    // first run for a brand nobody had cited — the moment a customer looks for.
    const empty = answer("a1", "2026-03-12T00:00:00Z", []);
    const gained = diffAnswers({ prompt: "q", before: empty, after: B });
    expect(gained.changes).toHaveLength(2);
    expect(gained.changes.every((c) => c.kind === "gained")).toBe(true);
    expect(gained.summary).toMatch(/2 appeared/i);
  });

  it("keeps the prompt verbatim on the result", () => {
    // The diff is shown beside the question; a normalised or truncated prompt
    // would make the two disagree on screen.
    const diff = diffAnswers({
      prompt: "  Best CRMs for SMB?  ",
      before: A,
      after: B,
    });
    expect(diff.prompt).toBe("  Best CRMs for SMB?  ");
  });
});
