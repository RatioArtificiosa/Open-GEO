import { describe, expect, it } from "vitest";
import { phaseSegments } from "./pageSpeedModel";

const sample = {
  connectionTimeMs: 13,
  timeToSecureConnectionMs: 18,
  waitingTimeMs: 0,
  downloadTimeMs: 5,
  durationTimeMs: 36,
};

describe("phaseSegments", () => {
  it("sums to the document's own duration, which is why a stacked bar is honest", () => {
    // The vendor's own sample: 13 + 18 + 0 + 5 = 36, exactly `duration_time`. Unlike the
    // resources below it, these phases genuinely add up, so each is a real share of the page.
    const segments = phaseSegments(sample);
    const sum = segments.reduce(
      (total, segment) => total + (segment.ms ?? 0),
      0,
    );
    expect(sum).toBe(sample.durationTimeMs);
    expect(
      segments.reduce((total, segment) => total + (segment.share ?? 0), 0),
    ).toBeCloseTo(1, 10);
  });

  it("keeps the phases in the order they happen", () => {
    expect(phaseSegments(sample).map((segment) => segment.label)).toEqual([
      "Connect",
      "Secure connection",
      "Waiting (TTFB)",
      "Download",
    ]);
  });

  it("keeps an unreported phase as null rather than dropping it", () => {
    // "The vendor did not report this" and "this took no time" are different claims; dropping
    // the first would silently renormalise the bar and make the rest look longer than they are.
    const segments = phaseSegments({
      ...sample,
      timeToSecureConnectionMs: null,
    });
    const secure = segments.find(
      (segment) => segment.label === "Secure connection",
    );
    expect(secure?.ms).toBeNull();
    expect(secure?.share).toBeNull();
    expect(segments).toHaveLength(4);
  });

  it("reports no shares at all when there is no duration to divide by", () => {
    const segments = phaseSegments({
      connectionTimeMs: 5,
      timeToSecureConnectionMs: 5,
      waitingTimeMs: 5,
      downloadTimeMs: 5,
      durationTimeMs: 0,
    });
    expect(segments.every((segment) => segment.share === null)).toBe(true);
  });
});
