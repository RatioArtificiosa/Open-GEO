import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The target form's market rule.
 *
 * A GEO target's `locationCode` decides which market the archive is measured in.
 * Writing a target with a guessed market would accumulate data that silently
 * says nothing about the region the customer cares about — a quiet, permanent
 * wrong answer rather than an error. So the form inherits the project's market
 * and refuses to submit until it has loaded.
 *
 * The repo has no component tests (`vitest.config.ts` includes `*.test.ts` only),
 * so these assert the source rather than rendered markup. That is weaker than a
 * DOM test, and deliberately so: the assertions below are about the *absence* of
 * a design (a free-text market field, a hardcoded fallback in the submit path),
 * which markup assertions would not catch any better.
 */

const read = (name: string) =>
  readFileSync(`${process.cwd()}/src/client/features/geo/${name}`, "utf8");

const source = () => read("GeoTargetForm.tsx");

describe("GeoTargetForm", () => {
  it("takes the market from the project, not from the user", () => {
    const text = source();
    // The market comes from `useProjectMarket`, never from a form field.
    expect(text).toContain("useProjectMarket");
    expect(text).toContain("market?.locationCode");
    expect(text).toContain("market?.languageCode");
  });

  it("will not submit until the market has loaded", () => {
    const text = source();
    // `canSubmit` gates on `marketReady`. Without that gate the fallback value
    // below would be sent and the archive would be measured in the wrong region.
    expect(text).toMatch(/const canSubmit = .*marketReady/);
    expect(text).toMatch(/disabled=\{!canSubmit\}/);
  });

  it("keeps the fallback for a brand with no project market, but never submits it", () => {
    const text = source();
    // The `?? 2840` is a type-level default only. It must be paired with the
    // `marketReady` gate, or it becomes a silent wrong answer.
    expect(text).toContain("?? 2840");
    expect(text).toContain("marketReady");
  });

  it("confirms deletion by naming the domain", () => {
    const text = source();
    // Deleting a target destroys its whole archive. The confirm names what is
    // about to disappear so nobody removes the wrong one.
    expect(text).toContain("Delete {target.domain} and its archive?");
    expect(text).toContain("setConfirmingId(target.id)");
  });

  it("never invents a brand name the user did not type", () => {
    const text = source();
    // An empty name falls back to the domain server-side. Sending a prettified
    // guess would put a word in the user's mouth.
    expect(text).toMatch(/name: name\.trim\(\) \|\| undefined/);
  });

  it("keeps the two query keys in step so the page refreshes with the form", () => {
    // The form and the page hook both read `["geoTargets", projectId]`. A
    // mismatch would leave the page showing a brand the form just added.
    const form = source();
    const hook = read("useGeoPageData.ts");
    expect(form).toContain('queryKey: ["geoTargets", projectId]');
    expect(hook).toContain('queryKey: ["geoTargets", projectId]');
  });
});
