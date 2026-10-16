import { describe, expect, it } from "vitest";
import { rateLimit as sqliteRateLimit } from "@/db/better-auth-schema";
import { createBaseAuthConfig } from "./auth-config";
import { baseAuthOptions } from "./auth-options";

/**
 * Auth rate limiting is database-backed (A6).
 *
 * Better Auth's default limiter is in-memory — one bucket per Worker isolate,
 * so an attacker with N concurrent connections gets N budgets. These pins
 * keep the bucket global: storage "database" in config, the `rate_limit`
 * table in both dialects' generated schemas (shape mirrors better-auth's own
 * CLI reference output), and tight custom rules on the password endpoints
 * where brute force actually aims. No `as` casts: the config is inferred, so
 * a renamed key fails here rather than drifting.
 */
describe("auth rate limiting", () => {
  it("stores buckets in the database, not in isolate memory", () => {
    expect(baseAuthOptions.rateLimit.enabled).toBe(true);
    expect(baseAuthOptions.rateLimit.storage).toBe("database");
  });

  it("caps password endpoints tighter than the general budget", () => {
    expect(
      baseAuthOptions.rateLimit.customRules["/sign-in/email"],
    ).toMatchObject({
      window: 60,
      max: 10,
    });
    expect(
      baseAuthOptions.rateLimit.customRules["/sign-up/email"],
    ).toMatchObject({
      window: 60,
      max: 10,
    });
  });

  it("carries the limiter through the shared config builder", () => {
    expect(createBaseAuthConfig().rateLimit.storage).toBe("database");
  });

  it("has the rateLimit table wired through the barrel", () => {
    // The adapter writes { key, count, lastRequest } with no id of its own,
    // so the table must exist exactly as better-auth's CLI generates it.
    // Cross-dialect structure (pg included) belongs to schema-parity.test.ts
    // — importing a dialect barrel here would bypass the provider seam.
    expect(sqliteRateLimit).toBeDefined();
  });
});
