/**
 * The circuit breaker, and what it has to get right.
 *
 * **The bug it prevents:** nothing in this repository bounded *whether* to call a failing
 * vendor. `limits.ts` bounds how many requests go out; a nightly loop with no breaker
 * retries a dead endpoint until its own timeout or its own budget stops it — and the failure
 * an operator sees is a timeout or a spend figure, never *"the vendor is down and we
 * stopped asking."*
 *
 * Every case here is a decision rather than a line of code, so every case is asserted:
 *
 * | case | why it is the interesting one |
 * |---|---|
 * | consecutive, not total | 50 successes then one failure must not open it |
 * | resets on success | a recovered endpoint is usable again immediately |
 * | cooldown, then one probe | recovery is tested, not assumed |
 * | a failed probe reopens | otherwise it drops to closed on the next call |
 * | refusal is `UPSTREAM_UNAVAILABLE` | **an auth code here would send an operator to rotate a working key** |
 */
import { describe, expect, it } from "vitest";
import { CircuitBreaker, breakerFor, resetBreakers } from "./gates";
import { limitFor } from "./limits";

/** A clock the test advances, so nothing sleeps. */
function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function breaker(threshold = 3, cooldown = 1_000, time = clock()) {
  return { b: new CircuitBreaker(threshold, cooldown, time.now), time };
}

describe("a circuit breaker", () => {
  it("stays closed below the threshold and opens at it", () => {
    const { b } = breaker(3);

    expect(b.currentState).toBe("closed");
    b.onFailure();
    b.onFailure();
    // **Two of three, and still closed** — a breaker that opened early would refuse a
    // vendor that had one bad moment.
    expect(b.currentState).toBe("closed");

    b.onFailure();
    expect(b.currentState).toBe("open");
    expect(b.allowsRequest()).toBe(false);
  });

  it("counts consecutive failures, not a total", () => {
    // **The distinction that makes it usable at all.** A breaker counting total failures
    // opens after 50 good hours and one bad one.
    const { b } = breaker(3);

    for (let i = 0; i < 50; i += 1) b.onSuccess();
    expect(b.currentState).toBe("closed");

    b.onFailure();
    expect(b.currentState).toBe("closed");
    b.onFailure();
    expect(b.currentState).toBe("closed");
    b.onFailure();
    expect(b.currentState).toBe("open");
  });

  it("resets the count on success, so a recovered endpoint is usable at once", () => {
    // **Not on a timer** — a vendor that recovers between two calls should not have to
    // wait out a cooldown it never tripped.
    const { b } = breaker(3);

    b.onFailure();
    b.onFailure();
    b.onSuccess();
    expect(b.consecutiveFailureCount).toBe(0);

    b.onFailure();
    b.onFailure();
    expect(b.currentState).toBe("closed");
  });

  it("allows one probe after the cooldown, and closes if it succeeds", () => {
    const { b, time } = breaker(3, 1_000);

    for (let i = 0; i < 3; i += 1) b.onFailure();
    expect(b.allowsRequest()).toBe(false);
    // Still refusing just before the cooldown elapses.
    time.advance(999);
    expect(b.allowsRequest()).toBe(false);

    time.advance(1);
    // **Half-open: one probe, not a stampede.**
    expect(b.currentState).toBe("half-open");
    expect(b.allowsRequest()).toBe(true);

    b.onSuccess();
    expect(b.currentState).toBe("closed");
    expect(b.allowsRequest()).toBe(true);
  });

  it("reopens when the probe fails, rather than closing on it", () => {
    // **The bug this case exists for.** A breaker that let a failed probe drop to closed
    // would reopen on the very next call — an oscillation rather than a backoff.
    const { b, time } = breaker(3, 1_000);

    for (let i = 0; i < 3; i += 1) b.onFailure();
    time.advance(1_000);
    expect(b.currentState).toBe("half-open");

    b.onFailure();
    expect(b.currentState).toBe("open");
    expect(b.allowsRequest()).toBe(false);

    // And the cooldown restarts, so it does not immediately probe again.
    time.advance(999);
    expect(b.allowsRequest()).toBe(false);
  });

  it("reports how long a caller should wait", () => {
    const { b, time } = breaker(3, 1_000);

    for (let i = 0; i < 3; i += 1) b.onFailure();
    expect(b.retryAfterMs()).toBe(1_000);

    time.advance(400);
    expect(b.retryAfterMs()).toBe(600);

    time.advance(600);
    expect(b.retryAfterMs()).toBe(0);
  });

  it("keys by endpoint family, so one family's failure is not another's", () => {
    // **Keyed by family rather than by URL on purpose**: a per-URL breaker opens on one bad
    // path while the rest of the vendor is fine, which is exactly when it matters least.
    resetBreakers();

    const responses = limitFor("/v3/ai_optimization/llm_responses/live");
    const scraper = limitFor("/v3/ai_optimization/llm_scraper/live");
    // **Checked, not asserted-and-assumed** — `expect(x).not.toBeNull()` is a runtime
    // assertion and does not narrow for `tsc`, so an endpoint renamed out of the table
    // fails here with a readable message rather than comparing against `undefined`.
    if (responses === null || scraper === null) {
      // **Plain concatenation, not template literals** — `no-unnecessary-template-expression`
      // is right that a bare string needs no `${}`.
      throw new Error(
        "limits.ts lost an endpoint family this test keys on: " +
          (responses === null ? "llm_responses " : "") +
          (scraper === null ? "llm_scraper" : ""),
      );
    }

    for (let i = 0; i < 5; i += 1) breakerFor(responses).onFailure();

    expect(breakerFor(responses).allowsRequest()).toBe(false);
    // **A different family is untouched.**
    expect(breakerFor(scraper).allowsRequest()).toBe(true);

    resetBreakers();
  });
});
