import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The target id must travel as the id, never as the domain.
 *
 * ## The defect this pins
 *
 * `useGeoPageData` passed the target's *domain string* as `targetId` to the
 * uuid-validated `getGeoVisibility` and `getGeoCitationGap` server functions.
 * The validator rejects a domain before the service is reached, so the
 * visibility and gap sections could never load — and TypeScript could not see
 * it, because both bindings are `string`. Proven against the schema with a
 * scratch test (`safeParse({ targetId: "example.com" })` is invalid), fixed
 * by carrying the row's `id` in its own binding.
 *
 * ## Why a source scan rather than a render test
 *
 * This repository's vitest environment is `node` with no DOM renderer, so the
 * natural control — mount the hook and read the query keys — is unavailable
 * (the same reason `hookOrder.test.ts` scans). The scan asserts the property
 * that matters: every `targetId:` argument in the page-data hook names the id
 * binding, and the id binding derives from the row's `id`. A rename of either
 * binding breaks this test, which is the honest cost — and the failure will
 * point at exactly these lines.
 */

const SOURCE = readFileSync(
  "src/client/features/geo/useGeoPageData.ts",
  "utf8",
);

/**
 * Every `targetId:` argument in a source, in order. Extracted so the
 * negative control below drives the same matcher the file assertion uses —
 * a control testing a copy of the logic proves the copy.
 */
function targetIdArgValues(source: string): string[] {
  return [...source.matchAll(/targetId:\s*([a-zA-Z? ]+)/g)].map(
    (match) => match[1]?.trim() ?? "",
  );
}

function checkWiring(source: string): void {
  const args = targetIdArgValues(source);
  expect(args.length).toBeGreaterThan(0);
  for (const arg of args) {
    expect(arg).not.toContain("domain");
    expect(arg).toContain("targetId");
  }
}

describe("target id wiring", () => {
  it("derives the id binding from the target row's id", () => {
    expect(SOURCE).toContain("targetList?.[0]?.id");
  });

  it("passes the id binding, never the domain, as targetId", () => {
    checkWiring(SOURCE);
  });

  it("flags the original defect: a domain string as targetId", () => {
    // The matcher sees the defect's shape — a passing control here would
    // mean the file assertion above cannot see the defect it exists to
    // catch (proven by injection during development: this case failed at
    // the arg assertion).
    const defective = [
      'queryFn: () => getGeoVisibility({ data: { targetId: domain ?? "" } }),',
    ].join("\n");
    expect(targetIdArgValues(defective)).toHaveLength(1);
    expect(() => checkWiring(defective)).toThrow();
  });
});
