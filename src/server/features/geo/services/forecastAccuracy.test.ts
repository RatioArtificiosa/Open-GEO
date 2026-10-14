import { describe, expect, it } from "vitest";

import {
  FORECAST_MODEL_VERSION,
  type ForecastSnapshotRow,
} from "@/server/features/geo/services/forecastSnapshot";
import { forecastAccuracy } from "@/server/features/geo/services/forecastAccuracy";

/**
 * The accuracy read, and its three refusals.
 *
 * ## Why this is the file most worth having
 *
 * Every other module here produces a number. This one produces a **judgement about
 * a number**, and the judgement is where a forecast product either earns trust or
 * quietly spends it. All three refusals exist because the alternative is a score
 * that looks informative and is not:
 *
 * - an anchor scored as though it were a projection measures drift and calls it
 *   accuracy;
 * - a horizon scored early always reads as a miss, because a rising share sits
 *   below its own projection for most of the window;
 * - a missing measurement read as zero reads as "never cited" when the truth is
 *   "never looked at".
 *
 * The fourth rule is the one the product is *for*: `held` requires the measurement
 * to be inside the published interval, so a wide hedge cannot score as a hit.
 */

function snapshot(
  overrides: Partial<ForecastSnapshotRow> = {},
): ForecastSnapshotRow {
  return {
    projectId: "proj-1",
    domain: "acme.com",
    kind: "visibility_pace",
    subject: "chat_gpt",
    modelVersion: FORECAST_MODEL_VERSION,
    issuedOn: "2026-07-16",
    horizonDays: 90,
    // Predicted 40%, interval 30–50, from 40 prompts over 12 weeks.
    shareBp: 4000,
    lowBp: 3000,
    highBp: 5000,
    perWeekBp: 400,
    nowBp: 3400,
    basedOn: 40,
    basedOnWeeks: 12,
    confidence: "moderate",
    note: null,
    ...overrides,
  };
}

describe("forecastAccuracy: the horizon must have elapsed", () => {
  it("refuses to score a projection before its band is over", () => {
    const result = forecastAccuracy({
      snapshot: snapshot(),
      actual: 0.44,
      today: "2026-07-19",
    });
    expect(result.verdict).toBe("too-early");
    expect(result.errorBp).toBeNull();
    expect(result.summary).toContain("have not happened yet");
  });

  it("scores on the day the horizon ends, not the day after", () => {
    const result = forecastAccuracy({
      snapshot: snapshot(),
      actual: 0.42,
      today: "2026-10-14",
    });
    // Named in full, because `not.toBe("too-early")` would also pass on
    // `no-forecast`, `unmeasured` and `beat` — a weaker assertion than the claim.
    expect(result.verdict).toBe("held");
    expect(result.actualShareBp).toBe(4200);
    expect(result.errorBp).toBe(200);
    expect(result.summary).toContain("measured 42%");
  });

  it("scores long after the horizon ended, because a late reader is still asking", () => {
    const result = forecastAccuracy({
      snapshot: snapshot(),
      actual: 0.2,
      today: "2027-01-01",
    });
    expect(result.verdict).toBe("missed");
  });
});

describe("forecastAccuracy: the verdict is interval-first", () => {
  it("holds when the measurement is inside the published interval", () => {
    const result = forecastAccuracy({
      snapshot: snapshot(),
      actual: 0.31,
      today: "2026-10-14",
    });
    expect(result.verdict).toBe("held");
    expect(result.withinInterval).toBe(true);
    // Negative error, and still `held`: below the point estimate is not a miss.
    expect(result.errorBp).toBe(-900);
  });

  it("holds exactly at either edge, because an interval includes its bounds", () => {
    for (const actual of [0.3, 0.5]) {
      const result = forecastAccuracy({
        snapshot: snapshot(),
        actual,
        today: "2026-10-14",
      });
      expect(result.verdict).toBe("held");
    }
  });

  it("misses below the interval and says how far", () => {
    const result = forecastAccuracy({
      snapshot: snapshot(),
      actual: 0.29,
      today: "2026-10-14",
    });
    expect(result.verdict).toBe("missed");
    expect(result.errorBp).toBe(-1100);
    expect(result.summary).toContain("11% below what was predicted");
  });

  it("beats above the interval, and names the excess rather than only the sign", () => {
    const result = forecastAccuracy({
      snapshot: snapshot(),
      actual: 0.61,
      today: "2026-10-14",
    });
    expect(result.verdict).toBe("beat");
    expect(result.errorBp).toBe(2100);
    expect(result.summary).toContain("21% above what was predicted");
  });

  it("scores a forecast with no interval on the sign of its deviation", () => {
    const result = forecastAccuracy({
      snapshot: snapshot({ lowBp: null, highBp: null }),
      actual: 0.6,
      today: "2026-10-14",
    });
    // Well above the point with no published bound: the direction is the only thing
    // that can be said, and claiming a hold would be claiming a bound nobody made.
    expect(result.withinInterval).toBeNull();
    expect(result.verdict).toBe("beat");
    expect(result.summary).not.toContain("interval");
  });

  it("treats a one-basis-point deviation as rounding, not as a forecast failure", () => {
    // Both columns are rounded to basis points, so a share stored and re-read can
    // differ by one with nothing having happened. Calling that a miss would be
    // reporting rounding as error.
    //
    // **The actual is a true one-bp deviation.** The first draft used 0.40001, which
    // rounds to 4000 bp and produced an error of exactly zero — so the tolerance
    // under test was never exercised and the assertion passed for the wrong reason.
    const result = forecastAccuracy({
      snapshot: snapshot({ shareBp: 4000, lowBp: null, highBp: null }),
      actual: 0.4001, // 0.4001 → 4001 bp, one above the stored 4000.
      today: "2026-10-14",
    });
    expect(result.errorBp).toBe(1);
    expect(result.verdict).toBe("held");
  });

  it("calls a two-basis-point deviation outside no interval, because that is a real deviation", () => {
    const result = forecastAccuracy({
      snapshot: snapshot({ shareBp: 4000, lowBp: null, highBp: null }),
      actual: 0.4002, // → 4002 bp, two above.
      today: "2026-10-14",
    });
    expect(result.errorBp).toBe(2);
    expect(result.verdict).toBe("beat");
  });

  it("calls an exact hit an exact hit", () => {
    const result = forecastAccuracy({
      snapshot: snapshot(),
      actual: 0.4,
      today: "2026-10-14",
    });
    expect(result.errorBp).toBe(0);
    expect(result.summary).toContain("exactly as predicted");
  });
});

describe("forecastAccuracy: absence is never zero", () => {
  it("refuses to score a forecast whose engine declined", () => {
    const result = forecastAccuracy({
      snapshot: snapshot({ shareBp: null, lowBp: null, highBp: null }),
      actual: 0.44,
      today: "2026-10-14",
    });
    expect(result.verdict).toBe("no-forecast");
    expect(result.errorBp).toBeNull();
    expect(result.summary).toContain("declined to give a number");
  });

  it("reports an unmeasured actual as unmeasured, never as 0%", () => {
    const result = forecastAccuracy({
      snapshot: snapshot(),
      actual: null,
      today: "2026-10-14",
    });
    expect(result.verdict).toBe("unmeasured");
    expect(result.actualShareBp).toBeNull();
    expect(result.errorBp).toBeNull();
    expect(result.summary).toContain("not the same as nothing was cited");
  });
});

describe("forecastAccuracy: an anchor is not a projection", () => {
  it("refuses to score a zero-horizon row, because drift is not accuracy", () => {
    const result = forecastAccuracy({
      snapshot: snapshot({ horizonDays: 0 }),
      actual: 0.45,
      today: "2026-10-14",
    });
    expect(result.verdict).toBe("no-forecast");
    expect(result.summary).toContain("records a reading, not a projection");
  });

  it("scores the citation win row, whose horizon is the window it was measured over", () => {
    const result = forecastAccuracy({
      snapshot: snapshot({
        kind: "citation_win",
        domain: "acme.com",
        subject: "acme.com",
        horizonDays: 90,
        shareBp: 2100,
        lowBp: 1200,
        highBp: 3300,
        nowBp: 2100,
        basedOn: 60,
        perWeekBp: null,
      }),
      actual: 0.19,
      today: "2026-10-14",
    });
    expect(result.verdict).toBe("held");
    expect(result.subject).toBe("acme.com");
    expect(result.summary).toContain("60 measured units");
  });
});

describe("forecastAccuracy: the numbers are exact", () => {
  it("rounds the actual to the same rule the builder used", () => {
    const result = forecastAccuracy({
      snapshot: snapshot({ shareBp: 4000, lowBp: null, highBp: null }),
      actual: 0.55555,
      today: "2026-10-14",
    });
    expect(result.actualShareBp).toBe(5556);
    expect(result.errorBp).toBe(1556);
  });

  it("names the denominator it rests on, because a score without one is a mood", () => {
    const result = forecastAccuracy({
      snapshot: snapshot({ basedOn: 8 }),
      actual: 0.4,
      today: "2026-10-14",
    });
    expect(result.summary).toContain("8 measured units");
  });

  it("agrees with the builder about the same fraction, to the basis point", () => {
    // The read and the write share `toBp`; if they ever stop sharing it, this is
    // the test that fails, and a stored share would stop equalling its own re-read.
    const share = 0.3417;
    const written = snapshot({ shareBp: Math.round(share * 10000) });
    const result = forecastAccuracy({
      snapshot: written,
      actual: share,
      today: "2026-10-14",
    });
    expect(result.errorBp).toBe(0);
  });
});
