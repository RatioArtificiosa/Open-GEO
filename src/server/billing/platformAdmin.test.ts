import { describe, expect, it } from "vitest";
import {
  isPlatformAdmin,
  listPlatformAdminUserIds,
  PLATFORM_ADMIN_ENV_VAR,
} from "./platformAdmin";

/**
 * The gate in front of the operator billing dial.
 *
 * The dial sets the platform's margin. It is the one number a stranger must
 * never reach, and the last version of this logic existed as a constant in an
 * MIT-licensed repository precisely because nobody drew a line around it.
 *
 * So the failures this suite is most concerned with are the *silent* ones: an
 * empty allowlist that admits everyone, a blank entry that counts as a match,
 * and an unknown owner id that reads as valid because the list was never
 * consulted at all. Each case below is written to fail if the gate ever starts
 * failing open.
 */

describe("listPlatformAdminUserIds", () => {
  it("splits a comma-separated list and drops blanks", () => {
    expect(listPlatformAdminUserIds("a, b ,c")).toEqual(["a", "b", "c"]);
  });

  it("treats a blank, absent or empty list as no owners", () => {
    expect(listPlatformAdminUserIds(undefined)).toEqual([]);
    expect(listPlatformAdminUserIds(null)).toEqual([]);
    expect(listPlatformAdminUserIds("")).toEqual([]);
    expect(listPlatformAdminUserIds("  ")).toEqual([]);
    expect(listPlatformAdminUserIds(" , , ")).toEqual([]);
  });
});

describe("isPlatformAdmin", () => {
  it("admits a listed user", () => {
    expect(isPlatformAdmin("u1", "u1,u2")).toBe(true);
  });

  it("refuses everyone when the allowlist is absent", () => {
    // The fail-closed default. A deployment that has not named an owner has
    // no owner, so there is nobody to admit — including whoever happens to be
    // signed in.
    expect(isPlatformAdmin("u1", undefined)).toBe(false);
    expect(isPlatformAdmin("u1", "")).toBe(false);
  });

  // A partial id that happens to share a prefix with a real owner must not
  // pass. `includes` on a string would let "u1" match "u10" and hand a
  // stranger the margin dial.
  it("refuses an unlisted id even when it shares a prefix", () => {
    expect(isPlatformAdmin("u10", "u1")).toBe(false);
    expect(isPlatformAdmin("u", "u1")).toBe(false);
  });

  it("refuses the empty string against any allowlist", () => {
    expect(isPlatformAdmin("", "u1")).toBe(false);
  });

  // The gate is deliberately blind to what an id *means*: it receives a string
  // and checks membership. It has no way to tell a user id from an
  // organization id, and pretending otherwise would be a shape check that an
  // attacker can satisfy.
  //
  // The protection is therefore on the caller's side, and it is a type-level
  // one: the only thing passed in is `context.userId`, which the authenticated
  // context guarantees is the user's own id. A tenant's administrator is not
  // the platform owner and their organization id is never offered here. This
  // test records that the gate does not correct for it if it ever were.
  it("does not attempt to interpret an id it cannot identify", () => {
    expect(isPlatformAdmin("org_1", "org_1")).toBe(true);
  });

  it("names the binding it reads", () => {
    expect(PLATFORM_ADMIN_ENV_VAR).toBe("PLATFORM_ADMIN_USER_IDS");
  });
});
