/**
 * The coercion rules, which are the difference between a control and a billed rejection.
 *
 * Switching source with `2004_present` selected is the case: Google serves that preset and
 * DataForSEO does not, so a component that simply kept the state would send an invalid task the
 * vendor charges for. Same for the type vocabulary, where `froogle` and `ecommerce` are two names
 * for one idea and each vendor only knows its own.
 */
import { describe, expect, it } from "vitest";
import {
  coerceType,
  coerceWindow,
  priceFor,
  typesFor,
  windowsFor,
} from "./trendSources";

describe("coerceWindow", () => {
  it("keeps a window both sources accept", () => {
    expect(coerceWindow("dataforseo", "past_30_days")).toBe("past_30_days");
    expect(coerceWindow("google", "past_30_days")).toBe("past_30_days");
  });

  it("replaces a Google-only window when the source becomes DataForSEO", () => {
    // The failure this prevents: the control still reads "2004 to now", the request carries it,
    // and DataForSEO rejects a task that was billed regardless.
    expect(coerceWindow("google", "2004_present")).toBe("2004_present");
    expect(coerceWindow("dataforseo", "2004_present")).toBe("past_12_months");
  });

  it("falls back rather than trusting an unknown value", () => {
    expect(coerceWindow("google", "nonsense")).toBe("past_12_months");
  });
});

describe("coerceType", () => {
  it("keeps a type the source knows", () => {
    expect(coerceType("google", "froogle")).toBe("froogle");
    expect(coerceType("dataforseo", "ecommerce")).toBe("ecommerce");
  });

  it("does not carry one vendor's name for shopping to the other", () => {
    // They mean the same thing to a human and are invalid to each vendor.
    expect(coerceType("dataforseo", "froogle")).toBe("web");
    expect(coerceType("google", "ecommerce")).toBe("web");
  });
});

describe("the source lists", () => {
  it("offers Google the windows DataForSEO cannot take, and vice versa", () => {
    expect(windowsFor("google").length).toBeGreaterThan(
      windowsFor("dataforseo").length,
    );
    expect(windowsFor("dataforseo").some((option) => option.googleOnly)).toBe(
      false,
    );
  });

  it("names each vendor's own type vocabulary", () => {
    expect(typesFor("google").map((option) => option.value)).toContain(
      "froogle",
    );
    expect(typesFor("dataforseo").map((option) => option.value)).toContain(
      "ecommerce",
    );
  });

  it("prices the two sources differently, which is why the choice matters", () => {
    expect(priceFor("google")).toBeGreaterThan(priceFor("dataforseo"));
  });
});
