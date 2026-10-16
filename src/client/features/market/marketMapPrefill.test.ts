import { describe, expect, it } from "vitest";
import { projectDomainFor } from "./MarketMapPage";

/**
 * The Market Map prefill contract.
 *
 * The field is honestly empty rather than guessing a target — a guessed
 * domain would spend the reader's money on another brand's profile. So the
 * lookup returns a domain only for an exact project-id match with a
 * non-null domain, and the component refills only the untouched empty
 * state (typed or cleared values are never overwritten).
 */
describe("projectDomainFor", () => {
  const projects = [
    { id: "p1", domain: "acme.com" },
    { id: "p2", domain: null },
  ];

  it("returns the project's own domain for an exact id match", () => {
    expect(projectDomainFor(projects, "p1")).toBe("acme.com");
  });

  it("reads unknown project or null domain as empty, never a guess", () => {
    expect(projectDomainFor(projects, "p9")).toBe("");
    expect(projectDomainFor(projects, "p2")).toBe("");
    expect(projectDomainFor([], "p1")).toBe("");
  });
});
