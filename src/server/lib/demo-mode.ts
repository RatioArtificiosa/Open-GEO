import { getOptionalEnvValue } from "@/server/lib/runtime-env";

/**
 * Demo mode lets a self-hoster run OpenGeo with **no DataForSEO account** and
 * see a populated product instead of an error page.
 *
 * Why this exists: the single biggest drop-off in self-hosting is "I don't have
 * an API key yet." Someone who runs `docker compose up`, gets a real GEO
 * dashboard, and only then decides to sign up for a key converts far better
 * than someone who meets a `Missing required environment variable` error.
 *
 * Contract:
 *  - DEMO_MODE=true short-circuits the authenticated DataForSEO fetch and
 *    returns realistic fixture data.
 *  - Every demo response is flagged (`demo: true`) so the UI can badge it and
 *    we never let demo numbers be mistaken for live ones.
 *  - No demo path may ever be used to bill a customer, and no demo number may
 *    be written into a customer's project as if it were real. Callers that
 *    persist data must check the flag.
 */
export type DemoEnvelope<T> = {
  data: T;
  demo: true;
};

let demoModePromise: Promise<boolean> | null = null;

/** True when DEMO_MODE is explicitly enabled. Cached for the process lifetime. */
export async function isDemoMode(): Promise<boolean> {
  if (!demoModePromise) {
    demoModePromise = (async () => {
      const raw = await getOptionalEnvValue("DEMO_MODE");
      return raw?.trim().toLowerCase() === "true";
    })();
  }
  return demoModePromise;
}

/** Test seam: reset the cached value. */
export function resetDemoModeCache(): void {
  demoModePromise = null;
}

/** Wrap a value as a demo response so callers can badge and exclude it. */
export function asDemo<T>(data: T): DemoEnvelope<T> {
  return { data, demo: true };
}
