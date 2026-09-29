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
