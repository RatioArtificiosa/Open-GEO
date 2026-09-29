import { describe, expect, it } from "vitest";
import { ENDPOINT_LIMITS, effectiveValue, limitFor } from "./limits";
import {
  __resetGatesForTests,
  gateFor,
  gatePressure,
  RateGate,
  Semaphore,
} from "./gates";

/**
 * The vendor's limits, and the two mechanisms that enforce them.
 *
 * The tests are about three things that all fail *quietly*: a limiter that
 * enforces nothing because its table is empty, a semaphore that leaks a permit on
 * a throw (so the effective limit creeps down until everything stops), and a
 * rate gate that lets a burst through across a window boundary.
 */

describe("the limits table", () => {
  it("is not empty, because an empty table enforces nothing", () => {
    // The failure mode this file most needs to rule out: a module that looks
    // installed, passes every test, and permits everything. A scan that finds
    // nothing is green.
    expect(ENDPOINT_LIMITS.length).toBeGreaterThan(3);
  });

  it("gives every limit a source a reader can check", () => {
    // A limit with no provenance is a number someone guessed, and it will be
    // quoted in a support reply.
    for (const limit of ENDPOINT_LIMITS) {
      expect(limit.source.length).toBeGreaterThan(30);
      expect(limit.value).toBeGreaterThan(0);
      expect(limit.divisor).toBeGreaterThanOrEqual(1);
    }
  });

  it("matches the most specific prefix first", () => {
    // Order matters because the first match wins, and a broad prefix placed
    // early would swallow the specific entries below it.
    expect(
      limitFor("/v3/keywords_data/google_ads/search_volume/live")?.value,
    ).toBe(12);
    expect(limitFor("/v3/ai_optimization/llm_responses/live")?.value).toBe(30);
    expect(
      limitFor("/v3/ai_optimization/llm_mentions/search/live")?.value,
    ).toBe(30);
    expect(
      limitFor("/v3/dataforseo_labs/google/related_keywords/live")?.value,
    ).toBe(1200);
  });

  it("falls back to the account-wide ceiling for an unknown endpoint", () => {
    // Deliberately the tightest bound, not "unlimited": a new client inheriting
    // no limit because nobody added a row is how the account gets throttled.
    expect(limitFor("/v3/something_new/live")?.value).toBe(2000);
    expect(limitFor("/v2/old/live")).toBeNull();
  });

  it("never enforces a limit of zero", () => {
    // A zero-concurrency gate deadlocks its caller, and the right response to a
    // misconfigured limit is to be wrong permissively for one call, not to hang.
    expect(
      effectiveValue({
        pathPrefix: "/x",
        kind: "concurrency",
        value: 0,
        divisor: 1,
        source: "s",
      }),
    ).toBe(1);
    expect(
      effectiveValue({
        pathPrefix: "/x",
        kind: "concurrency",
        value: 5,
        divisor: 99,
        source: "s",
      }),
    ).toBe(1);
  });

  it("leaves headroom below the vendor ceiling on every shared limit", () => {
    // Running at exactly the vendor's number means one slow call cascades into
    // rejections for everything behind it.
    for (const limit of ENDPOINT_LIMITS) {
      if (limit.divisor === 1) continue;
      expect(effectiveValue(limit)).toBeLessThan(limit.value);
    }
  });
});

describe("Semaphore", () => {
  it("bounds concurrency to the permit count", async () => {
    const sem = new Semaphore(3);
    const results: number[] = [];
    let peak = 0;
    let live = 0;
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        sem.run(async () => {
          live += 1;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 1));
          results.push(i);
          live -= 1;
          return i;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(results).toHaveLength(10);
  });

  it("releases the permit when the work throws", async () => {
    // The failure this class of bug produces is silent and slow: a leaked permit
    // means the effective limit creeps down a little on every failure, and the
    // symptom looks like a vendor problem rather than ours.
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(sem.free).toBe(1);
    // And it is still usable afterwards.
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
  });

  it("ignores a double release rather than inventing a permit", async () => {
    // A double release hands out a permit that does not exist, and the limit is
    // then quietly exceeded forever after — with no error to point at.
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.free).toBe(1);
  });

  it("serves waiters in order, so none starves", async () => {
    // Under sustained load a LIFO or unordered gate can starve a request
    // indefinitely, and the request that starves is the one that would have
    // reported a real finding.
    const sem = new Semaphore(1);
    const order: number[] = [];
    const first = sem.run(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(0);
    });
    const waiters = [1, 2, 3].map((n) =>
      sem.run(async () => {
        order.push(n);
      }),
    );
    await Promise.all([first, ...waiters]);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("passes the permit straight to a waiter instead of leaking it", async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire();
    let acquired = false;
    const waiter = sem.acquire().then((release) => {
      acquired = true;
      release();
    });
    await new Promise((r) => setTimeout(r, 1));
    expect(acquired).toBe(false);
    held();
    await waiter;
    // One permit was created and one is still available: the hand-off conserved
    // it rather than minting a second.
    expect(sem.free).toBe(1);
  });
});

describe("RateGate", () => {
  it("permits exactly the limit per window", () => {
    let now = 0;
    const gate = new RateGate(3, () => now);
    expect([gate.tryConsume(), gate.tryConsume(), gate.tryConsume()]).toEqual([
      true,
      true,
      true,
    ]);
    expect(gate.tryConsume()).toBe(false);
  });

  it("opens a new window after the minute elapses", () => {
    let now = 0;
    const gate = new RateGate(1, () => now);
    expect(gate.tryConsume()).toBe(true);
    expect(gate.tryConsume()).toBe(false);
    now = 60_000;
    expect(gate.tryConsume()).toBe(true);
  });

  it("never reports a negative wait", () => {
    // `setTimeout` with a negative delay fires immediately, which would defeat
    // the gate entirely — so this is a real invariant, not tidiness.
    let now = 0;
    const gate = new RateGate(1, () => now);
    gate.tryConsume();
    now = 30_000;
    expect(gate.msUntilNextSlot()).toBeGreaterThan(0);
    now = 120_000;
    expect(gate.msUntilNextSlot()).toBe(0);
  });
});

describe("the gate registry", () => {
  it("shares one gate per limit, not one per path", async () => {
    // The vendor's ceilings are per *account*, and an account is shared by every
    // isolate serving every project. Per-path gates would each stay under the
    // limit while the sum did not.
    __resetGatesForTests();
    const a = gateFor("/v3/ai_optimization/llm_mentions/search/live");
    const b = gateFor("/v3/ai_optimization/llm_mentions/target_metrics/live");
    expect(a).toBe(b);
  });

  it("gives different limits different gates", () => {
    __resetGatesForTests();
    const mentions = gateFor("/v3/ai_optimization/llm_mentions/search/live");
    const ads = gateFor("/v3/keywords_data/google_ads/search_volume/live");
    expect(mentions).not.toBe(ads);
  });

  it("returns nothing for a path with no limit", () => {
    expect(gateFor("/v2/old/live")).toBeNull();
  });

  it("reports queue pressure, which is the number worth alerting on", async () => {
    __resetGatesForTests();
    expect(gatePressure()).toEqual([]);
    const sem = gateFor("/v3/ai_optimization/llm_mentions/search/live");
    const held = sem instanceof Semaphore ? await sem.acquire() : null;
    expect(gatePressure()[0]?.queued).toBe(0);
    if (held !== null) held();
  });
});
