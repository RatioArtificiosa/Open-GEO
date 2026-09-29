import { describe, expect, it } from "vitest";
import { buildScoredTable, scoreRow } from "./aiNativeScore";
import type { DemandRow } from "./demandTable";

/**
 * The AI-Native Score.
 *
 * The spec asked for `(AI volume / Google volume)` normalized 0–100. The ratio
 * is fine; the *normalization* is the whole problem, because the quantity is
 * unbounded and no linear map onto 0–100 is neutral.
 *
 * So the tests here are mostly about the two anchors (parity = 50, the cap =
 * 100), about saturation being *declared* rather than silent, and about the
 * calendar sorting on the ratio — because every AI-dominant row scores 100, and
 * sorting on the score would return them in arbitrary order.
 */

const row = (
  keyword: string,
  aiToGoogle: DemandRow["aiToGoogle"],
  difficulty: number | null = null,
): DemandRow => ({
  keyword,
  googleVolume: 100,
  aiVolume: null,
  keywordDifficulty: difficulty,
  intent: null,
  aiToGoogle,
  aiToGoogleNote: "",
  opportunity: null,
});

describe("scoreRow", () => {
  it("puts parity at exactly 50", () => {
    // The one anchor that is a fact rather than a parameter: asked of AI as
    // often as on Google. It belongs in the middle of the scale.
    //
    // The 50 is written out rather than imported, deliberately: a test that
    // asserts a constant against itself passes when the constant moves. The
    // scale is the claim, so the scale's numbers live in the test.
    const scored = scoreRow(row("parity", 1));
    expect(scored.score).toBe(50);
    expect(scored.band).toBe("parity");
    expect(scored.saturated).toBe(false);
  });

  it("is linear below parity", () => {
    expect(scoreRow(row("half", 0.5)).score).toBe(25);
    expect(scoreRow(row("quarter", 0.25)).score).toBe(13);
  });

  it("scores a dead keyword 0 and says why", () => {
    const scored = scoreRow(row("dead", 0));
    expect(scored.score).toBe(0);
    expect(scored.band).toBe("ai-dead");
  });

  it("cancels every AI-dominant row at 100 and declares the cap", () => {
    // Above parity there is no second intrinsic anchor — nothing between "asked
    // as often as Google" and "infinitely AI-dominant" that means something. So
    // the scale saturates, and `saturated` is what stops 100 reading as a
    // measurement of how extreme the keyword is.
    const modest = scoreRow(row("modest", 2));
    const extreme = scoreRow(row("extreme", 900));
    expect(modest.score).toBe(100);
    expect(extreme.score).toBe(100);
    expect(modest.saturated).toBe(true);
    expect(extreme.saturated).toBe(true);
    expect(extreme.explanation).toMatch(/the real ordering/i);
  });

  it("cancels an unbounded ratio at the cap rather than reporting Infinity", () => {
    // `Infinity` would render as a number and mean nothing. 100 + `saturated` is
    // a floor with an explanation, which is a claim we can support.
    const scored = scoreRow(row("unsearched", "infinite"));
    expect(scored.score).toBe(100);
    expect(scored.saturated).toBe(true);
    expect(scored.explanation).toMatch(
      /capped at 100 because the quantity is/i,
    );
  });

  it("leaves an unscoreable row null rather than zero", () => {
    // Zero would say "nobody asks AI engines this". The truth is that we could
    // not compare it, and the two lead to opposite decisions.
    const scored = scoreRow(row("unknown", null));
    expect(scored.score).toBeNull();
    expect(scored.band).toBeNull();
  });

  it("never folds keyword difficulty into the score", () => {
    // A score that absorbed difficulty would be a different, worse metric
    // wearing this name — and priority is the user's judgement, not the
    // metric's. An easy keyword and a near-impossible one with the same ratio
    // must score identically.
    const easy = scoreRow(row("k", 0.5, 5));
    const hard = scoreRow(row("k", 0.5, 95));
    expect(easy.score).toBe(hard.score);
    expect(easy.keywordDifficulty).toBe(5);
    expect(hard.keywordDifficulty).toBe(95);
  });
});

describe("buildScoredTable", () => {
  it("sorts the calendar by the ratio, not the score", () => {
    // Every AI-dominant row scores 100, so a score sort would return them in
    // input order and destroy the ranking the feature exists to provide.
    const table = buildScoredTable([
      row("mid", 2),
      row("huge", 800),
      row("small", 1.2),
    ]);
    expect(table.calendar.map((r) => r.keyword)).toEqual([
      "huge",
      "mid",
      "small",
    ]);
  });

  it("puts an unbounded keyword above every finite ratio", () => {
    const table = buildScoredTable([
      row("finite", 9000),
      row("unsearched", "infinite"),
    ]);
    expect(table.calendar[0]?.keyword).toBe("unsearched");
  });

  it("excludes non-AI-dominant keywords from the calendar", () => {
    // The calendar answers "what should I write about for AI", so a keyword
    // nobody asks AI engines has no place in it, however well it ranks.
    const table = buildScoredTable([
      row("good", 5),
      row("parity", 1),
      row("weak", 0.1),
    ]);
    expect(table.calendar.map((r) => r.keyword)).toEqual(["good"]);
  });

  it("reports how many calendar rows the cap dropped", () => {
    // A silently truncated list reads as "that is everything", and the customer
    // pays for calls that produced rows nobody will see.
    const rows = Array.from({ length: 20 }, (_, i) => row(`k${i}`, 10 + i));
    const table = buildScoredTable(rows, 12);
    expect(table.calendar).toHaveLength(12);
    expect(table.calendarTruncated).toBe(8);
  });

  it("keeps every row in `rows`, including unscoreable ones", () => {
    const table = buildScoredTable([row("ok", 3), row("unknown", null)]);
    expect(table.rows).toHaveLength(2);
    expect(table.calendar).toHaveLength(1);
  });

  it("says the score is never averaged", () => {
    // The mean of three AI-dominant keywords and one dead one is a number about
    // nothing, and the summary is where a reader would look for it.
    const table = buildScoredTable([row("ok", 3), row("dead", 0)]);
    expect(table.summary).toMatch(/never averaged/i);
  });

  it("explains the cap rather than letting 100 read as a measurement", () => {
    const table = buildScoredTable([row("k", 5)]);
    expect(table.summary).toMatch(/no second anchor/i);
    expect(table.summary).toMatch(/the ratio is the real ordering/i);
  });

  it("reports an unscoreable table as having no score, not as a zero", () => {
    const table = buildScoredTable([row("unknown", null)]);
    expect(table.summary).toMatch(/no keyword could be scored/i);
  });
});
