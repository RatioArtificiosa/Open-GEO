import { describe, expect, it } from "vitest";
import { enforceOpenDeploymentGate } from "./previewGate";

/**
 * `enforceOpenDeploymentGate` — the gate that closes an open deployment.
 *
 * The finding it answers: `/projects` on a `workers.dev` preview returned 200 to
 * an unauthenticated caller, because `local_noauth` hands every caller an admin
 * identity and a workers.dev URL is public.
 *
 * ## The assertion that matters
 *
 * A request **with** the right secret must pass, and one without must not. A gate
 * that rejects everything passes the second test and fails the product; a gate
 * that accepts everything passes the first. Both directions are asserted, which
 * is the same reasoning that caught the nightly-capture meter.
 */

const SECRET = "preview-secret-value";
const url = (path: string) => new Request(`https://example.com${path}`);
const withBasic = (secret: string) =>
  new Request("https://example.com/", {
    headers: {
      Authorization: `Basic ${btoa(`opengeo:${secret}`)}`,
    },
  });

describe("enforceOpenDeploymentGate", () => {
  it("does not apply when no secret is set", () => {
    // Unset means open. Fail-closed would break every existing self-host
    // deployment at startup, which is worse than the hole this gates.
    expect(
      enforceOpenDeploymentGate(url("/"), "local_noauth", undefined),
    ).toBeNull();
    expect(
      enforceOpenDeploymentGate(url("/"), "local_noauth", "   "),
    ).toBeNull();
  });

  it("does not apply outside local_noauth", () => {
    // The other two modes carry real auth; gating on top would prompt twice.
    expect(
      enforceOpenDeploymentGate(url("/"), "cloudflare_access", SECRET),
    ).toBeNull();
    expect(enforceOpenDeploymentGate(url("/"), "hosted", SECRET)).toBeNull();
  });

  it("lets /api/health through so the gate cannot wedge health checks", () => {
    expect(
      enforceOpenDeploymentGate(url("/api/health"), "local_noauth", SECRET),
    ).toBeNull();
  });

  it("lets a request with the right secret through", () => {
    // The positive control. Without this, a gate that rejects everything would
    // look correct.
    expect(
      enforceOpenDeploymentGate(withBasic(SECRET), "local_noauth", SECRET),
    ).toBeNull();
  });

  it("rejects a request with no credentials", () => {
    const response = enforceOpenDeploymentGate(
      url("/"),
      "local_noauth",
      SECRET,
    );
    expect(response?.status).toBe(401);
  });

  it("rejects a wrong password", () => {
    const response = enforceOpenDeploymentGate(
      withBasic("not-the-secret"),
      "local_noauth",
      SECRET,
    );
    expect(response?.status).toBe(401);
  });

  it("rejects a wrong username even with the right password", () => {
    const request = new Request("https://example.com/", {
      headers: {
        Authorization: `Basic ${btoa(`attacker:${SECRET}`)}`,
      },
    });
    expect(
      enforceOpenDeploymentGate(request, "local_noauth", SECRET)?.status,
    ).toBe(401);
  });

  it("rejects a header that is not Basic", () => {
    const request = new Request("https://example.com/", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(
      enforceOpenDeploymentGate(request, "local_noauth", SECRET)?.status,
    ).toBe(401);
  });

  it("names the mechanism in the body, not just the refusal", () => {
    // An operator who lands here needs to know the shape of the credential. A
    // bare 401 sends them looking for an auth system that does not exist yet.
    const response = enforceOpenDeploymentGate(
      url("/"),
      "local_noauth",
      SECRET,
    );
    expect(response?.headers.get("WWW-Authenticate")).toContain("Basic");
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  });
});
