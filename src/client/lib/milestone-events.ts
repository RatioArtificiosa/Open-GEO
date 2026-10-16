/**
 * Once-per-milestone firing for funnel events.
 *
 * A funnel stage counts users who reached it. An effect that fires on every
 * mount counts renders, and a counter that grows with refreshes measures
 * nobody's conversion — which is what `useEffect(..., [projectId])` produces
 * on its own. This guard makes "first view" mean first view: the first call
 * with a key fires, every later call with the same key is a no-op.
 *
 * Window-free on purpose: the storage is a parameter, so the rule is unit
 * testable in node without a DOM, and the call sites pass `window.localStorage`
 * behind their own `typeof window` guard.
 */

export type MilestoneStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

/** The funnel stages guarded by `fireMilestoneOnce`, in one place. */
export const GEO_ACTIVATION_KEY = "geoActivationRecorded";
export const CITATION_GAP_KEY = "citationGapViewedRecorded";

/**
 * Fire once per key, then never again for that key.
 *
 * Returns true when `fire` ran. Storage failure fails open — the event fires
 * and the count may be high — because an uncounted conversion is lost data
 * while a page that breaks over analytics is a broken product.
 */
export function fireMilestoneOnce(
  storage: MilestoneStorage,
  key: string,
  fire: () => void,
): boolean {
  let seen: string | null = null;
  try {
    seen = storage.getItem(key);
  } catch {
    // Fail open; the mark below is best-effort for the same reason.
  }
  if (seen !== null) return false;
  fire();
  try {
    storage.setItem(key, "1");
  } catch {
    // Best-effort mark: the event already fired, and throwing here would turn
    // a telemetry gap into a page error.
  }
  return true;
}

/**
 * Forget every milestone mark, for logout.
 *
 * Marks live in the browser, not the account: without this a second user on
 * the same browser inherits the first user's funnel state and their activation
 * never fires. Called from `resetAnalyticsUser`, beside the PostHog reset, so
 * the two identities cannot disagree about who is signed in.
 */
export function clearMilestoneMarks(storage: MilestoneStorage): void {
  for (const key of [GEO_ACTIVATION_KEY, CITATION_GAP_KEY]) {
    try {
      storage.removeItem(key);
    } catch {
      // Best-effort like the mark itself: logout must not fail over telemetry.
    }
  }
}
