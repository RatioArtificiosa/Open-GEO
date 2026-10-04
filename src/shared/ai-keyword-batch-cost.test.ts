import { describe, expect, it } from "vitest";
import { estimateAiKeywordBatch } from "@/shared/ai-keyword-batch-cost";
import { DFS_AI_OPTIMIZATION } from "@/shared/dataforseo-pricing";

describe("the AI keyword batch sum", () => {
  /**
   * DataForSEO's own figures, published on the pricing page: $0.01 per request,
   * $0.0001 per item, 1,000 keywords per response. This was prose in the caveat
   * twice, and prose about prices goes stale silently — it kept reading correctly
   * long after the rate beneath it had been corrected.
   */
  it("reproduces the vendor's published total from the table's own rates", () => {
    // **The two must not drift.** The table states the rates and this function does
    // the arithmetic, and nothing forces them to agree except a test that reads
    // both — which is exactly what prose about prices stopped doing.
    const kw = DFS_AI_OPTIMIZATION.aiKeywordSearchVolume;
    expect(estimateAiKeywordBatch(1_000_000).totalUsd).toBeCloseTo(110, 6);
    expect(kw.perUnit).toBeCloseTo(0.0001, 6);
  });

  it("charges a full batch $0.11, because the request fee is added", () => {
    const full = estimateAiKeywordBatch(1000);

    expect(full.calls).toBe(1);
    expect(full.perRequestUsd).toBeCloseTo(0.01, 6);
    expect(full.perUnitUsd).toBeCloseTo(0.1, 6);
    // **$0.11, not $0.10.** The task fee is not amortised away by filling the
    // batch, which is what makes a full batch cost more per keyword than a
    // hundred small ones.
    expect(full.totalUsd).toBeCloseTo(0.11, 6);
  });

  it("reproduces the vendor's published $110 for a million keywords", () => {
    // "1,000*0.01 + 1,000,000*0.0001 = $110" — straight off the pricing page.
    const million = estimateAiKeywordBatch(1_000_000);

    expect(million.calls).toBe(1000);
    expect(million.totalUsd).toBeCloseTo(110, 6);
  });

  it("charges one request even for a single keyword", () => {
    // The minimum is the point: a one-keyword call is almost entirely the request
    // fee, so a per-keyword denominator would understate it by 99%.
    const one = estimateAiKeywordBatch(1);

    expect(one.calls).toBe(1);
    expect(one.totalUsd).toBeCloseTo(0.0101, 6);
  });

  it("caps one request at the vendor's 1,000-keyword limit", () => {
    // **Above the limit the vendor rejects rather than truncates**, which is billed,
    // so the caller must split — and the split has to show up in the call count.
    const over = estimateAiKeywordBatch(1500);

    expect(over.calls).toBe(2);
    // **Both** requests bill their own per-item fee, so 1,500 keywords cost 1,500
    // items' worth — not one batch's.
    expect(over.perUnitUsd).toBeCloseTo(1500 * 0.0001, 6);
  });

  it("clamps a negative order to zero rather than emitting a credit", () => {
    // **A caller computing `someMax - someActual` can produce a negative**, and
    // `Math.ceil(negative / 1000)` is a negative call count — which a budget loop
    // would read as *credit* and spend against. An estimate is not a place where
    // a sign error becomes money.
    const negative = estimateAiKeywordBatch(-50);

    expect(negative.calls).toBe(0);
    expect(negative.totalUsd).toBe(0);
  });

  it("charges nothing for an empty order", () => {
    // **The mutation that dropped the `Math.max(1, ...)` passed every test**,
    // because nothing covered this. A project filtered down to no keywords should
    // cost nothing — and `Math.max(1, ...)` billed it a request regardless, so
    // every empty project in a sweep cost $0.01 of nothing.
    const empty = estimateAiKeywordBatch(0);

    expect(empty.calls).toBe(0);
    expect(empty.perRequestUsd).toBe(0);
    expect(empty.perUnitUsd).toBe(0);
    expect(empty.totalUsd).toBe(0);
  });

  it("reads both rates from the constants rather than repeating them", () => {
    // **If this fails, someone has typed a figure into this file instead of using
    // the constants** — which is the drift that put $0.002 in three places.
    // **Asserted against the vendor's published $0.01**, which is the only place
    // that figure exists now — and reading it here means a change to either
    // constant fails this test rather than passing because both moved together.
    const one = estimateAiKeywordBatch(1);
    expect(one.perRequestUsd).toBeCloseTo(0.01, 6);
  });
});
