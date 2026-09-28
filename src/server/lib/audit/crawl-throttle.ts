/** Retries per URL after its first 429. Every 429 still pauses new URLs. */
const MAX_RETRIES = 3;
const FIRST_DELAY_MS = 30_000;
const MAX_INTERVAL_MS = 30_000;
const MAX_COOLDOWN_MS = 30 * 60_000;

/** Checkpointed between chunks so a new step does not forget site limits. */
export type CrawlThrottleState = {
  intervalMs: number;
  nextRequestAt: number;
  pausedUntil: number;
  consecutiveRateLimits: number;
  cooldownMs: number;
};

/** `Retry-After` is either delay-seconds or an HTTP-date. */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const value = header.trim();
  // Keep over-budget values finite for checkpoint serialization/arithmetic.
  if (/^\d+$/.test(value))
    return Math.min(Number(value) * 1_000, MAX_COOLDOWN_MS + 1);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

export interface CrawlThrottle {
  /** False when this chunk can no longer start a request. */
  ready(): Promise<boolean>;
  /** Pause the origin on every 429; return whether this URL may retry. */
  backoff(attempt: number, retryAfter: string | null): Promise<boolean>;
  /** A non-429 response breaks a run of consecutive refusals. */
  recovered(): Promise<void>;
  readonly checkpointFailed: boolean;
  readonly stopped: boolean;
  readonly state: CrawlThrottleState;
}

/** One audit's origin pacing. Long waits are resumed by the workflow. */
export function createCrawlThrottle(
  deadlineAt: number,
  previous?: CrawlThrottleState,
  persist?: (state: CrawlThrottleState) => Promise<void>,
): CrawlThrottle {
  const state: CrawlThrottleState = previous
    ? { ...previous }
    : {
        intervalMs: 1_000,
        nextRequestAt: 0,
        pausedUntil: 0,
        consecutiveRateLimits: 0,
        cooldownMs: 0,
      };
  let checkpointFailed = false;
  let checkpoint = Promise.resolve();
  const save = () => {
    const snapshot = { ...state };
    checkpoint = checkpoint
      .then(() => persist?.(snapshot))
      .catch((error) => {
        checkpointFailed = true;
        throw error;
      });
    return checkpoint;
  };
  const stopped = () =>
    checkpointFailed ||
    state.consecutiveRateLimits > MAX_RETRIES ||
    state.cooldownMs > MAX_COOLDOWN_MS;
  return {
    async ready() {
      while (!stopped()) {
        await checkpoint;
        const now = Date.now();
        const readyAt = Math.max(state.pausedUntil, state.nextRequestAt);
        if (now >= deadlineAt || readyAt >= deadlineAt) return false;
        if (readyAt <= now) {
          // Reserve synchronously: waiters waking together must take turns.
          state.nextRequestAt = now + state.intervalMs;
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, readyAt - now));
      }
      return false;
    },
    async backoff(attempt, retryAfter) {
      state.consecutiveRateLimits += 1;
      state.intervalMs = Math.min(MAX_INTERVAL_MS, state.intervalMs * 2);
      const delayMs = Math.max(
        state.intervalMs,
        parseRetryAfterMs(retryAfter) ??
          FIRST_DELAY_MS * 2 ** (state.consecutiveRateLimits - 1),
      );
      const now = Date.now();
      const pausedUntil = Math.max(state.pausedUntil, now + delayMs);
      state.cooldownMs += pausedUntil - Math.max(now, state.pausedUntil);
      state.pausedUntil = pausedUntil;
      await save();
      return !stopped() && attempt <= MAX_RETRIES;
    },
    async recovered() {
      if (state.consecutiveRateLimits === 0) return;
      state.consecutiveRateLimits = 0;
      await save();
    },
    get checkpointFailed() {
      return checkpointFailed;
    },
    get stopped() {
      return stopped();
    },
    get state() {
      return { ...state };
    },
  };
}
