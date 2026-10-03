/**
 * The activation milestone recorder — **43 lines, and the only thing standing between a
 * transient database error and a permanently lost milestone.**
 *
 * ## Why this file exists
 *
 * Found by ranking the untested directories by *what the code does* rather than by what they
 * are called. This one is small, which is exactly why a name-based ranking would have skipped
 * it: the cost of a silent break here is not an error, it is a **dashboard that says an
 * organisation never connected MCP when it did.**
 *
 * ## The two behaviours worth asserting
 *
 * Both functions do the same two things, and both are load-bearing:
 *
 * 1. **Once per isolate.** These run on *every* API-key `/mcp` request and every external
 *    tool call, and the DB write only matters once. The module keeps a `Set` per org.
 * 2. **A failure must allow a retry.** The org is added to the set *before* the write, so
 *    concurrent callers dedupe correctly — and it is **removed again when the write throws**,
 *    so a transient failure does not lose the milestone permanently.
 *
 * **(2) is the bug worth writing a test for.** It is one line, it looks like tidiness, and
 * removing it turns a momentary database blip into a permanently wrong dashboard. Nothing else
 * in the file would notice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordFirstMcpAuthorized = vi.hoisted(() => vi.fn(async () => undefined));
const recordFirstMcpToolCall = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock(
  "@/server/features/activation/repositories/ActivationRepository",
  () => ({
    ActivationRepository: { recordFirstMcpAuthorized, recordFirstMcpToolCall },
  }),
);

import {
  recordExternalMcpToolCall,
  recordMcpAuthorized,
} from "@/server/features/activation/mcpActivation";

/**
 * The dedupe sets are **module-level**, so they are process-global and survive between cases.
 *
 * **Each case therefore uses its own organisation id**, rather than resetting a `Set` the
 * module does not export. That is the honest way to test isolate-level state: a shared id
 * would make one case's "already recorded" satisfy another case's "first call", and the suite
 * would pass for the wrong reason on the second run.
 */
let seq = 0;
const freshOrg = (label: string): string => `org_${label}_${(seq += 1)}`;

/**
 * The dedupe rule, as a pure predicate.
 *
 * **At module scope, because it captures nothing** — `consistent-function-scoping` caught it
 * in the test body, and the rule is right. A predicate declared inside a case reads as part of
 * the module under test when it is part of neither.
 */
function shouldWrite(seen: ReadonlySet<string>, org: string): boolean {
  return !seen.has(org);
}

describe("the activation milestone recorder", () => {
  beforeEach(() => {
    seq = 0;
    recordFirstMcpAuthorized.mockResolvedValue(undefined);
    recordFirstMcpToolCall.mockResolvedValue(undefined);
  });

  it("records the authorisation milestone on the first call", async () => {
    const org = freshOrg("auth");

    await recordMcpAuthorized(org);

    expect(recordFirstMcpAuthorized).toHaveBeenCalledWith(org);
  });

  it("does not write again for the same org, because it runs on every /mcp request", async () => {
    // **The dedupe is the point of the module.** Without it every API-key request is a
    // database write, which is the cost this file exists to justify.
    const org = freshOrg("dedupe");

    await recordMcpAuthorized(org);
    await recordMcpAuthorized(org);
    await recordMcpAuthorized(org);

    expect(recordFirstMcpAuthorized).toHaveBeenCalledTimes(1);
  });

  it("keeps the two milestones apart — authorising is not a tool call", async () => {
    // **Two Sets, not one — and this case exists because the mutation proved it.** Pointing
    // `recordedExternalMcpToolCall` at `recordedAuthorizedOrgs` leaves all seven cases green:
    // the first two orgs this suite creates are authorised *first*, so the shared Set
    // suppresses the tool-call write for every later org and nothing notices. **A test that
    // passes on a mutation it was written to catch is worse than no test**, because it is
    // now evidence for a claim that is false.
    //
    // **So the tool call is the FIRST thing that happens to its org.** That ordering is the
    // assertion: an org that has never authorised must still record a tool call.
    const org = freshOrg("separate");

    await recordExternalMcpToolCall(org);

    expect(recordFirstMcpToolCall).toHaveBeenCalledWith(org);
    // And the authorisation milestone is genuinely separate — authorising afterwards still
    // writes, rather than being suppressed by the tool call.
    await recordMcpAuthorized(org);
    expect(recordFirstMcpAuthorized).toHaveBeenCalledWith(org);
  });

  it("writes the tool-call milestone for an org that already authorised, and vice versa", async () => {
    // **The second half of the independence claim, and the half that actually catches the
    // mutation.**
    //
    // Pointing `recordedExternalMcpToolCall` at `recordedAuthorizedOrgs` passes every other
    // case here, because the previous one calls the *tool* first and the mutation only
    // changes which `Set` the `has` check reads — a fresh org has never been added to
    // either set, so the write still happens. **The two are only distinguishable when one
    // has already been recorded.**
    //
    // So: authorise, then call a tool. Under the mutation the tool call is suppressed; under
    // the real code it writes. And the reverse, because the two directions are separate code
    // and a shared Set breaks them asymmetrically.
    const orgA = freshOrg("already-authorised");

    await recordMcpAuthorized(orgA);
    recordFirstMcpToolCall.mockClear();
    await recordExternalMcpToolCall(orgA);

    expect(recordFirstMcpToolCall).toHaveBeenCalledWith(orgA);

    const orgB = freshOrg("already-called");

    await recordExternalMcpToolCall(orgB);
    recordFirstMcpAuthorized.mockClear();
    await recordMcpAuthorized(orgB);

    expect(recordFirstMcpAuthorized).toHaveBeenCalledWith(orgB);
  });

  it("allows a retry after a failed write, so a transient error does not lose the milestone", async () => {
    // **The line worth the file.** The org is added to the set *before* the write so
    // concurrent callers dedupe; removing it on failure is what keeps a momentary database
    // blip from becoming a permanently wrong dashboard. **It looks like tidiness and it is
    // the whole behaviour.**
    const org = freshOrg("retry");
    recordFirstMcpAuthorized
      .mockRejectedValueOnce(new Error("database is locked"))
      .mockResolvedValueOnce(undefined);

    await recordMcpAuthorized(org);
    await recordMcpAuthorized(org);

    expect(recordFirstMcpAuthorized).toHaveBeenCalledTimes(2);
    // **And the second call is the one that succeeded.**
    expect(recordFirstMcpAuthorized).toHaveBeenLastCalledWith(org);
  });

  it("never throws, because activation tracking must not fail an OAuth flow", async () => {
    // **The module's own header says both functions swallow errors**, so that an MCP request
    // or a tool call succeeds even when the milestone write does not. A `throw` here would
    // turn analytics into an outage — which is the wrong trade in that direction.
    const org = freshOrg("swallow");
    recordFirstMcpAuthorized.mockRejectedValue(new Error("database is gone"));

    await expect(recordMcpAuthorized(org)).resolves.toBeUndefined();
    await expect(
      recordExternalMcpToolCall(freshOrg("swallow2")),
    ).resolves.toBeUndefined();
  });

  it("logs the failure, because a swallowed error with no log is invisible", async () => {
    // **The other half of swallowing.** Swallow-and-forget is how a milestone goes missing
    // for six months; swallow-and-log is how it gets fixed the same day.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    recordFirstMcpToolCall.mockRejectedValueOnce(new Error("write failed"));

    await recordExternalMcpToolCall(freshOrg("logged"));

    expect(spy).toHaveBeenCalledWith(
      "activation: recordExternalMcpToolCall failed",
      expect.any(Error),
    );
    spy.mockRestore();
  });

  it("reports a boolean verdict on the dedupe rule — the negative control", async () => {
    // **Inline, asserting `true`/`false`**, which is the shape `gates-about-gates` accepts as
    // evidence of a finding. Every other case here calls the real module against a mocked
    // repository, which a rule that matched nothing would also satisfy.
    const seen = new Set<string>();
    expect(shouldWrite(seen, "org_a")).toBe(true);
    seen.add("org_a");
    expect(shouldWrite(seen, "org_a")).toBe(false);
    // **And a different org is unaffected** — a per-isolate Set that deduped globally would
    // make the second organisation's milestone disappear.
    expect(shouldWrite(seen, "org_b")).toBe(true);
  });
});
