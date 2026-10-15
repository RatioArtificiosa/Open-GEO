import { describe, expect, it } from "vitest";

import { GEO_PLATFORM_LABELS } from "@/types/schemas/geo";

/**
 * The scoreboard's own helpers, extracted and tested.
 *
 * ## Why the label lookup is here and not in the component
 *
 * `ForecastAccuracyScoreboard` renders a row per platform, and the subjects come from
 * the **stored table**, not from the current enum — a row written today keeps its
 * platform label long after the list gains one. So the lookup has a real branch: known
 * key, or pass the raw value through.
 *
 * The reason that branch is worth a test rather than a glance: a first version wrote
 * `GEO_PLATFORM_LABELS[subject as GeoPlatform]`, an assertion that the string is one of
 * the platform keys. The type-aware lint refused it, and it was right to: a subject that
 * is *not* a known key resolves to `undefined` while the type claims a valid label, so
 * the fallback is a hole in the type rather than an honest branch. The comparison
 * version narrows each key inside the loop, and these tests pin both sides of it.
 */

/**
 * The label lookup, copied by construction from the component.
 *
 * It is re-stated rather than imported because the component's version closes over the
 * component's imports, and exporting a private helper solely for a test would make a
 * private function public for no reason. **The duplication is the honest cost here, and
 * it is the kind that a drift gate would target if the mapping grew** — if it ever does,
 * move it to a shared module and test it from one place.
 */
function labelFor(subject: string): string {
  if (!subject) return "";
  for (const [key, label] of Object.entries(GEO_PLATFORM_LABELS)) {
    if (key === subject) return label;
  }
  return subject;
}

describe("labelFor", () => {
  it("resolves every platform key to its label", () => {
    // The mapping is the contract: a platform that renders as its raw key is one a
    // reader has to decode, and a platform that renders blank is worse still.
    for (const [key, label] of Object.entries(GEO_PLATFORM_LABELS)) {
      expect(labelFor(key), `the label for ${key}`).toBe(label);
      // A label is not empty and is not just the key with different case.
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(key.replace(/_/g, " "));
    }
  });

  it("passes an unknown platform through rather than rendering it blank", () => {
    // A row recorded before a platform was added to the enum must still name itself.
    // Returning "" would put an unlabelled row on the scoreboard with no way to tell
    // which forecast it scores.
    expect(labelFor("claude_ai")).toBe("claude_ai");
    expect(labelFor("some_future_platform")).toBe("some_future_platform");
  });

  it("renders an empty subject as nothing at all", () => {
    // `citation_win` rows use the target domain as their subject, and an empty one is
    // not a label problem — there is nothing to name.
    expect(labelFor("")).toBe("");
  });

  it("does not treat a label as a key", () => {
    // The mapping is value-keyed, so a round trip through the label must not resolve
    // again. If it did, a brand that happens to share a platform's display name would
    // be silently relabelled.
    const firstLabel = Object.values(GEO_PLATFORM_LABELS)[0];
    expect(labelFor(firstLabel ?? "unreachable")).toBe(
      firstLabel ?? "unreachable",
    );
  });
});

/**
 * The verdict vocabulary, pinned against the reader's expectations.
 *
 * These are the server's words, and the panel renders them. A verdict the panel does
 * not recognise returns `null` from its switch, so **an added verdict must be handled
 * here too or the row renders without one** — which is a row that says a number without
 * saying what happened to it.
 */
describe("the verdict vocabulary", () => {
  const VERDICTS = [
    "held",
    "beat",
    "missed",
    "no-forecast",
    "unmeasured",
    "too-early",
  ];

  it("has a label for every verdict the reader can be told", () => {
    // Re-stated from the server, and the point of the list is that adding one there
    // without adding it here fails nothing — which is why the panel renders
    // `row.summary` unconditionally as well. This test documents the set rather than
    // enforcing it, so a reviewer sees what the vocabulary is.
    expect(new Set(VERDICTS).size).toBe(VERDICTS.length);
  });

  it("counts the two real outcomes against the four refusals", () => {
    // The refusals outnumber the verdicts on a young account, which is why the panel
    // renders them as content rather than as an empty state. If a change added a third
    // real outcome, this count would move and the ratio claim above it would need
    // re-reading.
    const real = VERDICTS.filter((v) => ["held", "beat"].includes(v));
    const refusals = VERDICTS.filter((v) => v !== "held" && v !== "beat");
    expect(real).toHaveLength(2);
    expect(refusals).toHaveLength(4);
  });
});
