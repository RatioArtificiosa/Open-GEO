/**
 * The funnel's declared stages.
 *
 * ## The event firing is the smaller half
 *
 * That the stage records the right name is worth an assertion, and it is a
 * one-liner. What is worth a file is the other half: **an analytics failure must
 * never take down a signup.** The hook runs in `databaseHooks.user.create.after`,
 * so the user row already exists — throwing out of here would mean a signup that
 * created an account and then returned an error, which is a user who cannot log in
 * with an account they own.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_FUNNEL_EVENTS,
  FUNNEL_EVENTS,
  type FunnelEvent,
} from "./analytics-events";

describe("the funnel's declared stages", () => {
  it("declares one event per stage, and no two stages share a name", () => {
    expect(ALL_FUNNEL_EVENTS.length).toBe(4);
    expect(new Set(ALL_FUNNEL_EVENTS).size).toBe(4);
  });

  it("names each stage by what happened, not by what we hoped", () => {
    // Typed as the union, so a value that the declaration could not have produced
    // is a compile error rather than a passing test against a wrong string.
    const expected: FunnelEvent[] = [
      "signup",
      "billing_plan_changed",
      "geo_activation_first_dashboard",
      "geo_citation_gap_viewed",
    ];
    // A set, not a sorted list: the lib target is ES2022, so there is no
    // Array#toSorted, and .sort() on the real arrays would mutate them.
    expect(new Set(ALL_FUNNEL_EVENTS)).toEqual(new Set(expected));
    // The names reach PostHog, so they are the funnel's column headers. A stage
    // named after an intention rather than an action is a column nobody can
    // interpret six months later.
    expect(FUNNEL_EVENTS.signup).toBe("signup");
    expect(FUNNEL_EVENTS.planChanged).toBe("billing_plan_changed");
    expect(FUNNEL_EVENTS.geoActivation).toBe("geo_activation_first_dashboard");
    expect(FUNNEL_EVENTS.citationGapViewed).toBe("geo_citation_gap_viewed");
  });

  it("keeps the free-tool stage out of the app's list", () => {
    // It fires on the marketing site under Plausible, not PostHog. Listing it
    // here would fail the funnel gate for a stage this repository does not own,
    // which teaches the next reader that the gate is wrong rather than that the
    // architecture has two analytics paths.
    expect(ALL_FUNNEL_EVENTS).not.toContain("free_tool_run");
  });
});
