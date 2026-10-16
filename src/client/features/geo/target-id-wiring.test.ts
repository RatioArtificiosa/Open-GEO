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

describe("target id wiring", () => {
  it("derives the id binding from the target row's id", () => {
    expect(SOURCE).toContain("targetList?.[0]?.id");
  });

  it("passes the id binding, never the domain, as targetId", () => {
    const targetIdArgs = [...SOURCE.matchAll(/targetId:\s*([a-zA-Z? ]+)/g)].map(
      (match) => match[1]?.trim(),
    );
    expect(targetIdArgs.length).toBeGreaterThan(0);
    for (const arg of targetIdArgs) {
      expect(arg).not.toContain("domain");
      expect(arg).toContain("targetId");
    }
  });
});
