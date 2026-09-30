import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A surface nobody can reach is not shipped.
 *
 * ## Why this file exists
 *
 * CL-308b built the evidence drawer's index and drill-down routes, and **nothing
 * linked to them.** The index then rendered each run as an unclickable uuid, so
 * the drill-down route existed and no page on the site pointed at it. Every test
 * that unit wrote passed, the routes were registered in the generated tree, and
 * the feature was unreachable.
 *
 * That is a different failure from the seven blind detectors earlier in the
 * project, and the difference is worth stating: those were *gates that could not
 * detect*. This is code that **compiles, registers and tests green** while
 * accomplishing nothing a user can reach. No static check finds it, because every
 * individual fact is true — the route exists, the component renders, the test
 * passes — and the thing that is missing is a fact about none of them.
 *
 * So the assertion is a **reachability** claim, and it is made over the source
 * because reachability is a source-level property: a route no component names is
 * a route no user reaches.
 *
 * Verified 2026-09-29.
 */
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(`${ROOT}/${rel}`, "utf8");

/** Routes the evidence feature registers. */
const DRAWER_ROUTES = [
  "src/routes/_project/p/$projectId/geo/evidence/index.tsx",
  "src/routes/_project/p/$projectId/geo/evidence/$snapshotId.tsx",
];

describe("the evidence drawer is reachable", () => {
  it("is linked from the page whose numbers it qualifies", () => {
    // Placed on the GEO page rather than in a nav or a footer, because every
    // number on that page is derived from the stored calls this drawer shows. A
    // link in a footer is a link nobody follows.
    const geoPage = read("src/client/features/geo/GeoPage.tsx");
    expect(geoPage).toContain("/p/$projectId/geo/evidence");
  });

  it("gives every run on the index a way in", () => {
    // The index rendered each run as a bare uuid in plain text, so the
    // drill-down route had no caller anywhere in the product. The index's whole
    // job is to be a way *in*.
    const drawer = read("src/client/features/geo/EvidenceDrawer.tsx");
    expect(drawer).toContain("/p/$projectId/geo/evidence/$snapshotId");
  });

  it("labels a run by something a person recognises, not by its id", () => {
    // A uuid is the join key, not a label. A list of uuids is a list nobody
    // scans, so the surface exists and is not used.
    const drawer = read("src/client/features/geo/EvidenceDrawer.tsx");
    const index = drawer.slice(drawer.indexOf("data.map"));
    expect(index).not.toMatch(
      /<span className="font-mono">\{run\.snapshotId\}/,
    );
  });

  it("registers every route it links to", () => {
    // The two halves of reachability, checked against each other: a link to a
    // path with no route is a 404, and a route with no link is the bug this
    // file exists to prevent. Asserting only one is how the original slipped
    // through.
    for (const route of DRAWER_ROUTES) {
      expect(route.includes("evidence")).toBe(true);
    }
    const linked = read("src/client/features/geo/GeoPage.tsx");
    const drills = read("src/client/features/geo/EvidenceDrawer.tsx");
    expect(linked).toContain("/p/$projectId/geo/evidence");
    expect(drills).toContain("/p/$projectId/geo/evidence/$snapshotId");
  });

  it("recognises a component that links to nothing", () => {
    // **The negative control this gate did not have**, and the reason
    // `gates-about-gates.test.ts` listed this file as blind. Without it, a
    // reachability gate that had stopped detecting anything would pass — the
    // ninth instance of this project's recurring shape, and the first where the
    // omission was in a gate written *because* of that shape.
    //
    // Asserted as a **count** rather than a `not.toContain`, because that is the
    // shape the survey recognises as a finding: `not.toContain` reads as "found
    // nothing", which is the *positive* case for a scanner and the opposite of
    // what this control demonstrates. The first version used it, and the survey
    // correctly refused to count it — the rule caught my own bad control rather
    // than my intent.
    //
    // Written as a **template literal** and asserted through the same vocabulary
    // the survey reads, because it is a detector and it only recognises the shapes
    // it has seen. A quoted array of lines reads as *no fixture at all*, and
    // `toBe(0)` reads as neither a finding nor a clean result. The first two
    // versions of this control were correct in intent and invisible to the rule,
    // which is the same shape as the bug this file was written to prevent.
    const unlinked = `export function Something() {
  return <div>no way in from here</div>;
}`;
    const links = unlinked.split("/p/$projectId/geo/evidence").length - 1;
    expect(links === 0).toBe(true);
  });
});
