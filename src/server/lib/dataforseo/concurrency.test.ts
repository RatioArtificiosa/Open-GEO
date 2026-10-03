// **Write the missing test rather than only recording the gap.** `core.ts` runs every
// request through `gate.run(send)` / `withRateSlot`, so the 30-concurrency property holds
// today — and nothing would notice if it stopped, because **no test counts how many calls
// were in flight at once.**
//
// ## How to test it without a network
//
// The gate wraps `send`, so the property is observable at the point where `send` is invoked:
// count the concurrent entries and the maximum that ever overlapped. `fetch` is the seam —
// `dataforseoPost` takes a `baseUrl`, so a local stub answers every call and the test
// measures the client rather than the vendor.
//
// ## And why it belongs to this file rather than to `gates.test.ts`
//
// `gates.test.ts` tests the semaphore **in isolation** — that it admits N and refuses N+1.
// That is a real test of the right thing, and it is **not** this test. What can break is
// `core.ts` *stopping awaiting the gate*, which leaves `gates.test.ts` perfectly green
// because the semaphore still works. **A unit test of a component cannot catch the
// integration being removed.**
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// The transport reads DEMO_MODE (via demo-mode -> getOptionalEnvValue) **before**
// authenticating, so a partial mock of runtime-env must supply both getters. This is
// `core.test.ts`'s shape for the same reason, and getting it wrong surfaces as a missing
// environment variable rather than as the concurrency failure the test is about.
vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "encoded-credentials"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import { dataforseoPost } from "./core";
import { limitFor } from "./limits";

const AI_LLM_RESPONSES = "/v3/ai_optimization/llm_responses/live";

describe("the client honours the endpoint's concurrency limit", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never has more requests in flight than the endpoint allows", async () => {
    /**
     * **The assertion is the peak, not the total.** A test that awaited all fifty calls
     * and checked they all succeeded would pass even with no gate at all — the failure
     * mode is *too many at once*, which only a maximum exposes.
     */
    const limit = limitFor(AI_LLM_RESPONSES);
    // **Checked, not asserted-and-assumed.** `expect(limit).not.toBeNull()` is a runtime
    // assertion and does not narrow for `tsc`, so the dependency is read once and tested
    // here — which also means an endpoint renamed out of the table fails this test with a
    // clear message rather than dividing by `undefined`.
    if (limit === null) {
      throw new Error(
        `no limit row for ${AI_LLM_RESPONSES} — the concurrency ceiling this test measures is gone`,
      );
    }
    expect(limit.kind).toBe("concurrency");

    // `effectiveValue` is what the client actually builds the semaphore from, and the
    // vendor's own number is 30 divided by a divisor — so the assertion is against the
    // enforced figure, not against 30, or it would fail for the wrong reason.
    const enforced = Math.max(
      1,
      Math.floor(limit.value / Math.max(1, limit.divisor)),
    );

    let inFlight = 0;
    let peak = 0;

    vi.mocked(fetch).mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Hold the slot open briefly so overlap is real rather than incidental.
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(
        JSON.stringify({
          tasks: [{ id: "1", status_code: 20000, result: [] }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    // **More callers than permits**, so an ungated client peaks above the limit and this
    // fails. That is the point: the fixture has to be able to fail.
    const callers = enforced + 20;
    await Promise.all(
      Array.from({ length: callers }, () =>
        dataforseoPost("/v3/ai_optimization/llm_responses/live", []),
      ),
    );

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(callers);
    expect(peak).toBeLessThanOrEqual(enforced);
    // And the gate was doing something: without it the peak would equal `callers`.
    expect(peak).toBeLessThan(callers);
  });
});
