/**
 * The model-catalog gate's own contract, and the reason it is worth having.
 *
 * ## Why a gate that scans source needs tests of its own
 *
 * Its job is to notice when a model name drifts out of the snapshot, so the thing
 * it is checking is itself a text pattern. A text pattern that has never been
 * watched fail is a text pattern that matches nothing — and a gate matching
 * nothing reports clean, which is the one outcome worse than a failing gate.
 *
 * The module is written to be importable for exactly this reason: the gate runs on
 * import when it is the entry point, so the detectors are exported and tested here
 * rather than run during the test's own load.
 */
import { describe, expect, it } from "vitest";
import {
  hardcodedModels,
  platforms,
  snapshot,
  snapshotDate,
} from "./check-model-catalog.mjs";

describe("the model catalog scan", () => {
  it("reads every platform out of the module rather than a list of its own", () => {
    const slugs = platforms();
    // Four today. The point is not the number but that they came from the source:
    // a list written here would be a second declaration, and the day a fifth
    // platform ships the gate would keep checking four.
    expect(slugs.length).toBe(4);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain("chat_gpt");
    expect(slugs).toContain("perplexity");
  });

  it("reads a non-empty snapshot for every platform", () => {
    const snap = snapshot();
    for (const slug of platforms()) {
      expect(snap[slug], slug).toBeTruthy();
      // A `Record<string, string[]>` lookup keyed by a platform slug, so a slug
      // the snapshot does not carry is a legal absence — the assertion above it
      // already fails for a missing slug, and this one is about it being empty.
      expect(snap[slug]?.length, slug).toBeGreaterThan(0);
    }
  });

  it("finds the hardcoded model names in the constants", () => {
    const found = hardcodedModels();
    // The patrol's default plus one per platform in the explorer's map.
    expect(found.length).toBe(5);
    const names = found.map((entry) => entry.name);
    // `gpt-5` is the patrol default and also the chat_gpt entry, so the set is
    // smaller than the list. Both spellings of the same model have to agree with
    // the snapshot, which is why the list is kept rather than deduplicated.
    expect(new Set(names).size).toBe(4);
    expect(names).toContain("gpt-5");
  });

  it("every name it finds is a name the snapshot also carries", () => {
    // The invariant the whole gate exists for, asserted as a property of the real
    // tree. If a constant drifts, this fails with the name and the location —
    // which is the same output the CI gate produces.
    const snapshotted = new Set(Object.values(snapshot()).flat());
    for (const entry of hardcodedModels()) {
      expect(
        snapshotted.has(entry.name),
        `${entry.where} names ${entry.name}`,
      ).toBe(true);
    }
  });

  it("reads the snapshot's documented date, so its age is checkable", () => {
    const date = snapshotDate();
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
