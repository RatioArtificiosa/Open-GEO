import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * CL-501-web's edge states, pinned without a DOM.
 *
 * The panel's whole job is refusing to show numbers it cannot stand behind —
 * pending, error, refusal, thin sample, missing direction, skipped runs — so
 * each state below asserts the source still renders its distinct sentence.
 * Same deliberate weakness as GeoTargetForm.test.ts documents: the repo has
 * no component tests, and these assert the branches exist rather than that
 * they paint. Deleting a refusal branch fails here before a reader ever sees
 * a confident number where a refusal belonged.
 */

const read = (name: string) =>
  readFileSync(`${process.cwd()}/src/client/features/geo/${name}`, "utf8");

const source = () => read("VisibilityForecast.tsx");

describe("VisibilityForecast edge states", () => {
  it("names loading as loading, never as data", () => {
    expect(source()).toContain("Loading forecast");
  });

  it("names a read fault as ours, never as the reader's visibility", () => {
    const text = source();
    expect(text).toContain("This panel could not be read");
    expect(text).toContain("not a statement");
    expect(text).toContain("about your visibility");
  });

  it("refuses a percentage it cannot stand behind, with the reason", () => {
    const text = source();
    expect(text).toContain("will not show a percentage it cannot stand behind");
    expect(text).toContain("Too few prompts");
  });

  it("prints the interval as the measurement, not decoration", () => {
    expect(source()).toContain("That spread is the measurement");
  });

  it("renders the server's direction reading verbatim, including its absence", () => {
    const text = source();
    // Null perWeek reads the server sentence alone; a present one still
    // carries the sentence beside the number. Both arms, or the refusal half
    // silently disappears.
    expect(text).toContain("forecast.direction.perWeek === null");
    expect(text).toContain("forecast.direction.reading");
    expect(text).toContain("points per week");
    expect(text).toContain("forecast.doesNotClaim");
  });

  it("accounts every skipped run by name", () => {
    const text = source();
    expect(text).toContain("Runs not included ({skipped})");
    expect(text).toContain("series.skipped.unknownDenominator");
    expect(text).toContain("series.skipped.noText");
    expect(text).toContain("series.skipped.noAnswers");
  });

  it("scopes the forecast to the project looking at it", () => {
    // Project A's cached forecast served inside project B is a wrong number
    // with no error anywhere; the query key is what prevents it.
    expect(source()).toContain(
      'queryKey: ["geoVisibilityForecast", projectId, domain, platform]',
    );
  });
});
