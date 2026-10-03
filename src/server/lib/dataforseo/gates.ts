import { effectiveValue, limitFor, type EndpointLimit } from "./limits";

/**
 * A counting semaphore.
 *
 * Written by hand rather than pulled in as a dependency, for one reason: the
 * whole point of this module is that a request **waits** for a slot rather than
 * failing. `p-limit` would do the same job, but the failure mode we care about
 * here is subtle and worth owning: a waiter that is never released starves
 * silently, and the symptom is a workflow that stops mid-run with no error
 * anywhere. Owning 30 lines means the release path is a `finally`.
 *
 * ## FIFO, and why that matters
 *
 * Waiters are served in the order they arrived. A LIFO or unordered gate is
 * faster in the average case and can starve a request indefinitely under
 * sustained load — and the request that starves is the one that would have
 * reported a real finding to the customer.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = Math.max(1, Math.floor(permits));
  }

  /** Slots free right now. Diagnostics only — it is a hint, not a guarantee. */
  get free(): number {
    return this.available;
  }

  /** How many callers are queued. The number to alert on. */
  get queued(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.makeRelease();
    }
    // A promise whose only resolver is the release function. No timeout is added
    // here on purpose: a bounded wait belongs to the call site, which knows
    // whether it is inside a user request (must not hang) or a workflow (may
    // wait), and a timeout baked into a semaphore is a policy nobody chose.
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    return this.makeRelease();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      // `finally`, always. A throw that skipped the release would leak a permit
      // permanently, and the symptom — the limit creeping down until everything
      // stops — would look like a vendor problem rather than our bug.
      release();
    }
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      // Idempotent. A double release would hand out a permit that does not
      // exist, and the limit would then be quietly exceeded forever after.
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next !== undefined) {
        next();
        // The permit passes straight to the waiter; `available` stays as it is.
        return;
      }
      this.available += 1;
    };
  }
}

/**
 * A fixed-window rate gate.
 *
 * A token bucket would be the more accurate model, and a fixed window is chosen
 * anyway for one reason: **it cannot burst across a window boundary the way a
 * naive implementation does.** A counter that resets on the minute can let 2N
 * requests through in the space between two adjacent resets, and the vendor's
 * ceiling is a true rate, not a per-calendar-minute quota. Overrunning it is not
 * a "we were 1 over" event — it degrades *other* endpoints' results, which is a
 * worse failure than being slightly conservative.
 *
 * The window is anchored when the gate is constructed rather than on first use,
 * so every Worker isolate agrees on where the boundaries are.
 */
export class RateGate {
  private count = 0;
  private windowStart: number;
  private readonly now: () => number;

  constructor(
    private readonly limit: number,
    now: () => number = Date.now,
  ) {
    this.now = now;
    this.windowStart = now();
  }

  /** Requests used in the current window. Diagnostics only. */
  get used(): number {
    return this.count;
  }

  /**
   * Milliseconds until the next slot, or 0 when one is free.
   *
   * Non-negative by construction: a caller passing this to `setTimeout` with a
   * negative value gets an immediate call, which would defeat the gate entirely.
   */
  msUntilNextSlot(): number {
    const now = this.now();
    if (now - this.windowStart >= WINDOW_MS) {
      this.count = 0;
      this.windowStart = now;
    }
    if (this.count < this.limit) return 0;
    return Math.max(0, WINDOW_MS - (now - this.windowStart));
  }

  /** Take a slot. Returns false when the window is full. */
  tryConsume(): boolean {
    const wait = this.msUntilNextSlot();
    if (wait > 0) return false;
    this.count += 1;
    return true;
  }
}

const WINDOW_MS = 60_000;

/**
 * The registry of gates, one per distinct limit, for the lifetime of the Worker
 * isolate.
 *
 * Keyed by the matched limit's identity rather than by path, so every
 * `ai_optimization` call shares one gate. That sharing is the point: the vendor's
 * ceilings are **per account**, and an account is shared across every isolate
 * serving every project. Per-path gates would each stay under the limit while the
 * sum did not, which is the failure this exists to prevent.
 *
 * Stated limitation, because it matters: this is per-isolate. Cloudflare runs
 * many isolates, so N isolates each holding 15 permits is 15N against a vendor
 * ceiling of 30. The cross-isolate bound is the Cloudflare rate-limit binding
 * already declared for `/mcp`; a truly global bound needs a shared counter, and
 * saying so is better than implying a guarantee the module cannot make.
 */
const semaphores = new Map<string, Semaphore>();
const rateGates = new Map<string, RateGate>();
/** The identity a limit is shared under. */
function keyFor(limit: EndpointLimit): string {
  return `${limit.kind}:${limit.pathPrefix}:${limit.value}`;
}

export function gateFor(path: string): Semaphore | RateGate | null {
  const limit = limitFor(path);
  if (limit === null) return null;
  const key = keyFor(limit);
  const value = effectiveValue(limit);
  if (limit.kind === "concurrency") {
    let existing = semaphores.get(key);
    if (existing === undefined) {
      existing = new Semaphore(value);
      semaphores.set(key, existing);
    }
    return existing;
  }
  let existing = rateGates.get(key);
  if (existing === undefined) {
    existing = new RateGate(value);
    rateGates.set(key, existing);
  }
  return existing;
}

/**
 * Wait for a rate slot, then run.
 *
 * The wait is **cancellable**, which is the whole reason this is a function
 * rather than a `sleep` at the call site: a rate-limited request queued behind a
 * full window should be able to give up when its caller does. A `sleep` that
 * ignored the abort signal would keep a cancelled request alive for up to a
 * minute, holding a Worker slot for a caller that is already gone.
 */
export async function withRateSlot<T>(
  gate: RateGate,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (;;) {
    if (signal?.aborted === true) {
      throw new Error(
        "The DataForSEO request was aborted while queued for a rate slot",
      );
    }
    const wait = gate.msUntilNextSlot();
    if (wait === 0 && gate.tryConsume()) return await fn();
    // Re-check rather than sleeping the full window: it may have opened between
    // the last poll and now, and a blind sleep would add a full interval of
    // latency to a request that is already allowed to go. Capped at 250ms so a
    // cancellation is never more than a quarter-second away from being noticed.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(1, Math.min(wait, 250)));
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

/** Test seam. Production code must not reset limits mid-flight. */
export function __resetGatesForTests(): void {
  semaphores.clear();
  rateGates.clear();
}

/** Queue depths across every gate, for a health endpoint or a log line. */
export function gatePressure(): Array<{
  key: string;
  queued: number;
  free: number;
}> {
  return [...semaphores.entries()].map(([key, gate]) => ({
    key,
    queued: gate.queued,
    free: gate.free,
  }));
}

/**
 * A circuit breaker, so a failing vendor is not called all night.
 *
 * ## Why this exists beside the semaphore
 *
 * The gates in this module bound **how many** requests go out. Nothing bounded **whether at
 * all** when the vendor is failing: a nightly capture loop would retry a dead endpoint until
 * its own timeout or its own budget stopped it, and the failure an operator saw was a timeout
 * or a spend figure — never *"the vendor is down and we stopped asking."*
 *
 * CL-120 calls this behaviour **non-negotiable**, and it was the one of its ten with neither
 * an implementation nor an assertion. Everything else it lists exists.
 *
 * ## The states
 *
 * ```
 * CLOSED    --failure x threshold-->  OPEN        nothing is attempted
 * CLOSED    --success-->             CLOSED       (and the failure count resets)
 * OPEN      --after cooldown-->       HALF_OPEN   one probe, not a stampede
 * HALF_OPEN --success-->            CLOSED
 * HALF_OPEN --failure-->             OPEN
 * ```
 *
 * Three decisions worth stating, because each is a policy rather than an implementation
 * detail:
 *
 * - **Consecutive failures, not a total.** Fifty successes then one failure is not a failing
 *   vendor, and a total-count breaker opens on it.
 * - **The count resets on success, not on a timer.** A recovered endpoint does not have to
 *   wait out a cooldown it never tripped.
 * - **One probe in HALF_OPEN.** Recovery is tested rather than assumed — the same reason the
 *   concurrency gate counts its peak rather than trusting that the semaphore works.
 *
 * ## Why the refusal is UPSTREAM_UNAVAILABLE
 *
 * **Not an auth error and not a billing error**, and the reason is specific: a breaker that
 * reported itself as a credential failure would send an operator to rotate a working API key
 * during a vendor outage. A vendor being down is exactly what the run log has to say.
 */
export class CircuitBreaker {
  /** closed | open | half-open — as data, so a test can assert on the state itself. */
  private state: "closed" | "open" | "half-open" = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    /** Consecutive failures that open the circuit. */
    private readonly failureThreshold: number,
    /** Milliseconds the circuit stays open before one probe is allowed. */
    private readonly cooldownMs: number,
    /** Injected so a test never has to sleep. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  get currentState(): "closed" | "open" | "half-open" {
    // **Derived rather than stored**, so an elapsed cooldown reads as half-open without
    // anything having to run to move the state.
    if (
      this.state === "open" &&
      this.now() - this.openedAt >= this.cooldownMs
    ) {
      return "half-open";
    }
    return this.state;
  }

  /**
   * Failures since the last success. Diagnostics only — the state is derived, so a caller
   * should branch on {@link currentState} rather than on this count.
   */
  get consecutiveFailureCount(): number {
    return this.consecutiveFailures;
  }

  /** Whether a call may be attempted. True in CLOSED and in an elapsed HALF_OPEN. */
  allowsRequest(): boolean {
    return this.currentState !== "open";
  }

  /** Milliseconds until the next probe is allowed, for a caller that would rather wait. */
  retryAfterMs(): number {
    if (this.state !== "open") return 0;
    return Math.max(0, this.cooldownMs - (this.now() - this.openedAt));
  }

  onSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
  }

  onFailure(): void {
    if (this.state === "half-open") {
      // The probe failed: straight back to open, and the cooldown restarts. A breaker that
      // let a failed probe drop to closed would reopen on the very next call.
      this.state = "open";
      this.openedAt = this.now();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }
}

/**
 * Breakers, keyed by the same endpoint-family identity `gateFor` uses.
 *
 * **Keyed by family rather than by URL on purpose.** A per-URL breaker opens on one bad
 * path while the rest of the vendor is fine, and the first storm of per-path failures is
 * exactly when it is least useful. The shared key also means a family's failure backs off
 * that family rather than the whole account.
 */
const breakers = new Map<string, CircuitBreaker>();

export function breakerFor(
  limit: EndpointLimit,
  failureThreshold = 5,
  cooldownMs = 60_000,
): CircuitBreaker {
  const key = `${limit.kind}:${limit.pathPrefix}:${limit.value}`;
  const existing = breakers.get(key);
  if (existing !== undefined) return existing;
  const created = new CircuitBreaker(failureThreshold, cooldownMs);
  breakers.set(key, created);
  return created;
}

/**
 * Drop every breaker.
 *
 * **For tests, and the reason is not laziness**: the module-level map is shared state that
 * survives between cases in a file, so a breaker left open by one test silently refuses
 * requests in the next and the failure lands on an unrelated assertion. The same reason
 * `semaphores` above is module-level — process-global is correct for a Worker, where every
 * isolate handles many requests, and wrong for a test, which is why this exists.
 */
export function resetBreakers(): void {
  breakers.clear();
}
