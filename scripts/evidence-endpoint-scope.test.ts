import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The evidence endpoint must be scoped by project, not by the id alone.
 *
 * ## Why a source scan and not a test
 *
 * The property is that `getGeoEvidence` checks ownership *before* asking the
 * drawer. A mocked call would happily return evidence for whatever id it was
 * given, so a test of the handler with a mock drawer proves only that the handler
 * called the drawer. The thing that can go wrong is an ordering: someone
 * reorders the ownership check below the drawer call, or drops it, and no unit
 * test of a mocked collaborator notices.
 *
 * So the assertion is on the source order, and it is verified by mutation below.
 *
 * ## What the id alone would mean
 *
 * A snapshot id is a uuid. Guessing one is not the threat; **having one is**. They
 * arrive in URLs, in logs, in support threads and in a customer's own bookmarks,
 * so a drawer that scopes on the id alone is a read of another organisation's
 * prompts — which is the most sensitive thing this product holds. It is a
 * capability, not a secret, so the check has to be structural.
 */
const SERVER_FNS = "src/serverFunctions/geo.ts";

function source(): string {
  return readFileSync(SERVER_FNS, "utf8");
}

function handlerBody(): string {
  const all = source();
  const start = all.indexOf("export const getGeoEvidence");
  expect(start, "getGeoEvidence is missing").toBeGreaterThan(-1);
  const end = all.indexOf("export const", start + 1);
  return all.slice(start, end === -1 ? all.length : end);
}

describe("getGeoEvidence scoping", () => {
  it("checks ownership before it reads anything", () => {
    // The order is the whole property. Checking afterwards is not a weaker
    // version of the same thing: by then the evidence has already been fetched,
    // and the only thing left to do is decline to send it — which is a
    // different and more fragile design than not fetching it.
    const body = handlerBody();
    const check = body.indexOf("ownsSnapshot");
    const read = body.indexOf("getEvidenceForSnapshot");
    expect(check, "no ownership check in the handler").toBeGreaterThan(-1);
    expect(read, "no drawer call in the handler").toBeGreaterThan(-1);
    expect(check).toBeLessThan(read);
  });

  it("scopes with the authorized project, never one from the request body", () => {
    // `context.projectId` comes from the session. A `data.projectId` would come
    // from the caller, and the validator ignores unknown keys — so a body that
    // carries its own projectId could otherwise read another project while the
    // code still reads like it is authorized. This is the same trap the
    // `upsertGeoTarget` comment above it describes.
    const body = handlerBody();
    expect(body).toContain("context.projectId");
    expect(body).not.toMatch(/data\.projectId/);
  });

  it("declines a snapshot the project does not own, with the honest message", () => {
    // "Not in this project's archive" rather than a 404-style not-found: the
    // drawer reports absence in words, and a caller who is genuinely pointing at
    // a real run of theirs gets the same answer, so the message cannot be used to
    // probe whether someone else's run exists.
    const body = handlerBody();
    expect(body).toMatch(/not in this project's archive/i);
    expect(body).toContain("gaps");
  });

  it("carries gaps and the reconciliation in the payload", () => {
    // A gap the client has to notice is a gap the client will not. The whole
    // point of CL-308 is that the honest answer travels with the data.
    const body = handlerBody();
    expect(body).toContain("gaps");
    expect(body).toContain("reconciliation");
    expect(body).toContain("getSpendReconciliation");
  });

  it("is an archive read, so it is not behind the paid-plan gate", () => {
    // The paid tier exists for the *live* reads that cannot be derived from
    // stored levels (CL-131's new/lost and top-cited). This one only reads rows
    // we already hold, so putting it behind a paywall would charge for a query.
    const body = handlerBody();
    expect(body).not.toContain("assertPaidPlanForLiveRead");
  });
});
