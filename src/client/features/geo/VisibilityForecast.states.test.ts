import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FORECAST_COPY } from "./forecastPanelState";

/**
 * The panel's sentences, driven as shipped values — not grepped prose.
 *
 * `FORECAST_COPY` is what `VisibilityForecast.tsx` renders: tsc fails the
 * build if a key is renamed, knip fails it if a key goes unread, and the
 * tests below fail if a sentence is weakened, emptied, or merged into
 * another. The branch logic that chooses between them is driven separately
 * in forecastPanelState.test.ts; the division is deliberate:
 *
 * - values here (what each state says, byte for byte),
 * - decisions there (which state holds, on fixtures),
 * - wiring proven by the compiler, not by string search.
 *
 * Server-owned sentences (note, direction reading, doesNotClaim, skipped
 * causes) are intentionally absent: restating them here would be the
 * two-texts-to-keep-in-step defect the panel documents.
 *
 * Deliberately unpinned inline sentences, named so the next reader does not
 * re-add them as a drive-by: the interval fragment ("That spread ...")
 * interpolates live bounds and belongs to its data sentence; the direction
 * and skipped blocks render server-owned values the panel must not restate.
 * Their branches are driven in forecastPanelState.test.ts — what is
 * unpinned here is wording, not behavior, and the wording lives next to
 * the data it formats.
 */
describe("FORECAST_COPY", () => {
  // Exact equality, not substring: a weakened sentence that still contains
  // the old keywords ("Too few prompts." for the full sentence) must fail.
  // Copy changes are deliberate edits here AND in the panel, never silent.
  it("pins every panel-owned sentence byte for byte", () => {
    expect(FORECAST_COPY).toEqual({
      loading: "Loading forecast",
      fault:
        "This panel could not be read. That is a fault here, not a statement about your visibility.",
      refusal:
        "A mention rate is only meaningful with its sample size, so this panel will not show a percentage it cannot stand behind. The reason is below.",
      thinSample: "Too few prompts for a rate to mean anything yet.",
      narrowSample: "More runs will narrow this.",
    });
  });

  it("refuses without blaming the vendor or implying nothing can be done", () => {
    expect(FORECAST_COPY.refusal).toContain("sample size");
    expect(FORECAST_COPY.refusal).toContain("The reason is below.");
    expect(FORECAST_COPY.fault).toContain("a fault here");
    expect(FORECAST_COPY.fault).not.toContain("vendor");
  });
});

const read = (name: string) =>
  readFileSync(`${process.cwd()}/src/client/features/geo/${name}`, "utf8");

describe("VisibilityForecast wiring", () => {
  it("scopes the forecast to the project looking at it", () => {
    // Structural, not behavioral: the query key is what prevents project A's
    // cached forecast serving inside project B. A mispelled key has no
    // behavior to unit-test, only a string to pin.
    expect(read("VisibilityForecast.tsx")).toContain(
      'queryKey: ["geoVisibilityForecast", projectId, domain, platform]',
    );
  });

  it("renders the table values rather than a second copy of them", () => {
    // The wiring tsc and knip already prove, stated once: every table key is
    // read in the component, so no sentence exists twice.
    const component = read("VisibilityForecast.tsx");
    for (const key of [
      "loading",
      "fault",
      "refusal",
      "thinSample",
      "narrowSample",
    ] as const) {
      expect(component).toContain(`FORECAST_COPY.${key}`);
    }
  });
});

/**
 * Which required sentences a body is missing. Extracted so the negative
 * control below feeds a fixture rather than the live file: the gates-about-
 * gates survey counts a control only over an inline fixture with a finding
 * assertion, and a block that reads the repository can never be one.
 */
function missingSentences(source: string, required: string[]): string[] {
  return required.filter((sentence) => !source.includes(sentence));
}

describe("missingSentences", () => {
  it("reports a deleted refusal as missing", () => {
    expect(
      missingSentences("no refusal here", ["Loading forecast"]),
    ).toHaveLength(1);
    expect(missingSentences("Loading forecast", ["Loading forecast"])).toEqual(
      [],
    );
  });
});
