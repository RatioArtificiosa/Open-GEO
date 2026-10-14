import { describe, expect, it } from "vitest";

import {
  FORECAST_KINDS,
  FORECAST_MODEL_VERSION,
  asForecastKind,
  citationWinSnapshot,
  visibilityForecastSnapshot,
  visibilityPaceSnapshot,
} from "@/server/features/geo/services/forecastSnapshot";

/**
 * The builders, and the two rules they exist to hold.
 *
 * ## Why these tests are about refusals, not about arithmetic
 *
 * `Math.round(x * 10000)` is not the interesting part. The interesting part is
 * what happens when the engine **declined** — a null share, a null interval, a zero
 * denominator — because that is the state the product spends most of its life in
 * for a young archive, and a builder that quietly turns it into a number is a
 * builder that publishes confidence it does not have.
 *
 * The second rule is the stamp: every row carries the model version, because an
 * unstamped row is unreadable the moment the estimator changes, and a builder that
 * forgot it would store something nobody could date.
 */

const base = {
  projectId: "proj-1",
  issuedOn: "2026-10-14",
  domain: "acme.com",
  subject: "chat_gpt",
  share: 0.34,
  low: 0.28,
  high: 0.4,
  perWeek: 0.004,
  now: 0.34,
  basedOn: 40,
  basedOnWeeks: 12,
  confidence: "moderate",
  note: "Forecasted from 24 of 24 runs.",
};

describe("forecastSnapshot builders", () => {
  it("stamps every row with the model version and the day it was made", () => {
    const row = visibilityForecastSnapshot(base);
    expect(row.modelVersion).toBe(FORECAST_MODEL_VERSION);
    expect(row.issuedOn).toBe("2026-10-14");
    expect(row.horizonDays).toBe(0);
  });

  it("converts shares to basis points, rounding half up", () => {
    const row = visibilityForecastSnapshot({ ...base, share: 0.12345 });
    // 1234.5 → 1235. A stored share and a re-read share must never differ by one.
    expect(row.shareBp).toBe(1235);
  });

  it("keeps a negative weekly change signed rather than dropping its sign", () => {
    const row = visibilityPaceSnapshot({
      ...base,
      perWeek: -0.02,
      horizonDays: 90,
    });
    expect(row.perWeekBp).toBe(-200);
  });

  it("stores a declining engine as nulls, never as zero", () => {
    const row = visibilityForecastSnapshot({
      ...base,
      share: null,
      low: null,
      high: null,
      perWeek: null,
      now: null,
    });
    expect(row.shareBp).toBeNull();
    expect(row.lowBp).toBeNull();
    expect(row.highBp).toBeNull();
    expect(row.perWeekBp).toBeNull();
    expect(row.nowBp).toBeNull();
    // The denominator survives the decline: "we measured 40 and could not say" is
    // a different sentence from "we measured nothing".
    expect(row.basedOn).toBe(40);
  });

  it("keeps the anchor's horizon at zero and the pace's at the band it names", () => {
    expect(visibilityForecastSnapshot(base).horizonDays).toBe(0);
    expect(
      visibilityPaceSnapshot({ ...base, horizonDays: 90 }).horizonDays,
    ).toBe(90);
    expect(citationWinSnapshot({ ...base, horizonDays: 90 }).horizonDays).toBe(
      90,
    );
  });

  it("names the citation win row by its target domain, with no weekly pace", () => {
    const row = citationWinSnapshot({
      ...base,
      domain: "acme.com",
      subject: "acme.com",
      share: 0.21,
      now: 0.21,
      perWeek: null,
      basedOn: 60,
      basedOnWeeks: null,
      horizonDays: 90,
    });
    expect(row.kind).toBe(FORECAST_KINDS.citationWin);
    expect(row.subject).toBe("acme.com");
    expect(row.shareBp).toBe(2100);
    expect(row.perWeekBp).toBeNull();
  });

  it("leaves the note beside the numbers, because a row without its basis is unreadable", () => {
    const row = visibilityPaceSnapshot({
      ...base,
      note: "Forecasted from 9 of 24 runs, and 15 older runs were not read.",
      horizonDays: 90,
    });
    expect(row.note).toContain("15 older runs were not read");
  });
});

describe("asForecastKind", () => {
  it("accepts the three kinds this build writes", () => {
    expect(asForecastKind("visibility_forecast")).toBe(
      FORECAST_KINDS.visibilityForecast,
    );
    expect(asForecastKind("visibility_pace")).toBe(
      FORECAST_KINDS.visibilityPace,
    );
    expect(asForecastKind("citation_win")).toBe(FORECAST_KINDS.citationWin);
  });

  it("refuses a kind this build does not know, rather than casting it through", () => {
    // A row written by a newer model must fail loudly. A cast would let it flow
    // into today's reads and render an empty panel with no error anywhere, which
    // is the bug that takes an afternoon to find.
    expect(() => asForecastKind("visibility_momentum_v2")).toThrow(
      /Unknown forecast kind/,
    );
    expect(() => asForecastKind("")).toThrow(/Unknown forecast kind/);
  });
});

describe("forecastSnapshot: the kinds are exhaustive and distinct", () => {
  it("has three kinds and no duplicate column value", () => {
    const values = Object.values(FORECAST_KINDS);
    expect(values).toHaveLength(3);
    expect(new Set(values).size).toBe(3);
  });
});
