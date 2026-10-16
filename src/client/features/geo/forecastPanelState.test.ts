import { describe, expect, it } from "vitest";
import {
  type ForecastCurrent,
  resolveForecastPanelState,
} from "./forecastPanelState";

/**
 * The forecast render decision, driven on the real path.
 *
 * Each arm below feeds the resolver inputs and asserts the state the panel
 * must render — loading, fault, full rate, refusal, thin sample, interval
 * halves, direction present/absent, note, skipped disclosure. Removing any
 * arm reopens a branch the reader depends on; the injection proof (a forced
 * showRate reopens the refusal test) lives in the commit, not in prose.
 */
const measured: ForecastCurrent = {
  basedOn: 8,
  rate: 0.25,
  low: 0.06,
  high: 0.61,
  confidence: "high",
};

const base = {
  isPending: false,
  isError: false,
  current: measured,
  hasNote: true,
  directionPerWeek: 0.01 as number | null,
  skipped: 0,
};

describe("resolveForecastPanelState", () => {
  it("loads and faults before anything about visibility", () => {
    expect(resolveForecastPanelState({ ...base, isPending: true })).toEqual({
      kind: "loading",
    });
    expect(resolveForecastPanelState({ ...base, isError: true })).toEqual({
      kind: "fault",
    });
  });

  it("shows the full rate with interval and no caveat when measured", () => {
    expect(resolveForecastPanelState(base)).toEqual({
      kind: "ready",
      showRate: true,
      showInterval: true,
      confidenceNote: null,
      showNote: true,
      directionPresent: true,
      showSkipped: false,
    });
  });

  it("refuses null, zero-sample, and null-rate currents identically", () => {
    for (const current of [
      null,
      { ...measured, basedOn: 0 },
      { ...measured, rate: null },
    ]) {
      expect(resolveForecastPanelState({ ...base, current })).toMatchObject({
        kind: "ready",
        showRate: false,
      });
    }
  });

  it("withholds a half interval on either side and names thin samples", () => {
    for (const current of [
      { ...measured, low: null },
      { ...measured, high: null },
    ]) {
      expect(resolveForecastPanelState({ ...base, current })).toMatchObject({
        showRate: true,
        showInterval: false,
      });
    }
    expect(
      resolveForecastPanelState({
        ...base,
        current: { ...measured, confidence: "none" },
      }),
    ).toMatchObject({ showRate: true, confidenceNote: "none" });
    expect(
      resolveForecastPanelState({
        ...base,
        current: { ...measured, confidence: "low" },
      }),
    ).toMatchObject({ showRate: true, confidenceNote: "narrow" });
  });

  it("reads direction absence and skipped runs as their own states", () => {
    expect(
      resolveForecastPanelState({ ...base, directionPerWeek: null }),
    ).toMatchObject({ directionPresent: false });
    expect(resolveForecastPanelState({ ...base, skipped: 4 })).toMatchObject({
      showSkipped: true,
    });
    expect(
      resolveForecastPanelState({ ...base, hasNote: false }),
    ).toMatchObject({ showNote: false });
  });
});
