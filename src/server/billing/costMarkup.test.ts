/**
 * The markup dial: parsing and application.
 *
 * The resolution order — operator row, then env, then no markup — is in
 * `costMarkup.db.test.ts`, because it needs a real table to be true.
 *
 * ## Why the resolution order is tested against a real table
 *
 * The whole point of moving the multiplier out of code is that the operator's
 * row beats the env binding, which beats no markup at all. That is a
 * precedence rule, and a precedence rule proven with a mocked query builder
 * proves nothing: the mock returns whatever the test told it to, so the one
 * thing under test — which source is consulted — is exactly the thing the
 * mock replaced.
 *
 * So the override is written to a real SQLite table and read back through the
 * same code path the request uses.
 */
import { describe, expect, it } from "vitest";
import { applyCostMarkup, NO_MARKUP, parseCostMarkup } from "./costMarkup";

describe("parseCostMarkup", () => {
  it("accepts a usable multiplier", () => {
    expect(parseCostMarkup("1.28")).toBe(1.28);
    expect(parseCostMarkup(" 2 ")).toBe(2);
    expect(parseCostMarkup("1")).toBe(1);
  });

  it("treats a missing or blank value as unset, not as an error", () => {
    expect(parseCostMarkup(undefined)).toBeNull();
    expect(parseCostMarkup(null)).toBeNull();
    expect(parseCostMarkup("")).toBeNull();
    expect(parseCostMarkup("   ")).toBeNull();
  });

  // The refusal is the point: a zero multiplier makes every hosted operation
  // free, and a non-finite one turns the credit arithmetic into NaN
  // deductions. Both are silent, which is why they are refused rather than
  // clamped — a clamped value would bill at a rate nobody chose.
  it("refuses zero, negatives and non-numbers", () => {
    expect(parseCostMarkup("0")).toBeNull();
    expect(parseCostMarkup("-1")).toBeNull();
    expect(parseCostMarkup("abc")).toBeNull();
    expect(parseCostMarkup("Infinity")).toBeNull();
    expect(parseCostMarkup("NaN")).toBeNull();
  });
});

describe("applyCostMarkup", () => {
  it("multiplies and rounds on the billing scale", () => {
    expect(applyCostMarkup(0.05, 1.28)).toBe(0.064);
    expect(applyCostMarkup(0.05, 1)).toBe(0.05);
  });

  it("leaves the raw rate untouched at no markup", () => {
    expect(applyCostMarkup(0.85, NO_MARKUP)).toBe(0.85);
  });
});
