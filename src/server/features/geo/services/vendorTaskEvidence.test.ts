import { describe, expect, it } from "vitest";
import { EVIDENCE_LIMITS, serialiseForEvidence } from "./vendorTaskEvidence";

/**
 * Evidence serialisation.
 *
 * The one property that matters: **truncation is always marked.** A silently
 * shortened body produces a re-derivation that looks correct and is not, which
 * is precisely the failure CL-603 exists to prevent — the table is supposed to
 * make metrics reproducible, and an unmarked truncation would make them
 * confidently wrong instead of honestly absent.
 */
describe("serialiseForEvidence", () => {
  it("returns null for nothing, which is a real state", () => {
    expect(serialiseForEvidence(undefined, 100)).toBeNull();
  });

  it("passes a short body through unchanged", () => {
    expect(serialiseForEvidence({ a: 1 }, 100)).toBe('{"a":1}');
  });

  it("passes a string through without re-encoding it", () => {
    // A body that is already a string must not become a JSON-quoted string: the
    // re-derivation would then see quotes it never sent.
    expect(serialiseForEvidence("raw body", 100)).toBe("raw body");
  });

  it("marks a truncation and says how much was dropped", () => {
    const out = serialiseForEvidence("x".repeat(500), 100);
    expect(out).toContain("truncated at 100 of 500 chars");
    // The head survives, because the head is usually the part that identifies the
    // call.
    expect(out?.startsWith("x".repeat(100))).toBe(true);
  });

  it("does not mark a body that exactly fills the cap", () => {
    // Off-by-one here would add a marker to a complete body, and a re-derivation
    // would then think it was looking at a partial one.
    const exact = "y".repeat(100);
    expect(serialiseForEvidence(exact, 100)).toBe(exact);
  });

  it("survives a value that cannot be serialised", () => {
    // A circular structure must not throw: the evidence write is best-effort by
    // design, and losing one body must never take down the call it describes.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(serialiseForEvidence(circular, 100)).toBe("[unserialisable]");
  });

  it("uses a different cap for request and response", () => {
    // A Lighthouse response is megabytes; a request we cannot reproduce is the
    // failure this table prevents. One cap for both would truncate the small,
    // important half to accommodate the large, unimportant one.
    expect(EVIDENCE_LIMITS.responseBody).toBeGreaterThan(
      EVIDENCE_LIMITS.requestBody,
    );
  });
});
