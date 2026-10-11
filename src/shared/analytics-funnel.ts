/**
 * The funnel's signup recorder.
 *
 * ## Why this is its own module
 *
 * The declaration file lists the stage names; this fires one. They started as one
 * file and the funnel gate — which excludes the declaration, because a
 * declaration is not a call — therefore said the signup stage was unwired. **The
 * gate was right: the thing that fires lives in the file that exempts itself.**
 *
 * Separating them also makes the two responsibilities named rather than
 * accidental. A reader looking for what the stages are opens the declaration; a
 * reader looking for what happens on signup opens this.
 */
import { FUNNEL_EVENTS } from "./analytics-events";

/**
 * Fire the funnel's signup stage.
 *
 * ## Why the capture is a parameter
 *
 * It is the only thing that touches the network and the only thing that can
 * fail. Passing it in makes the failure path testable rather than hoped for: the
 * caller passes a version that throws, and the assertion is that the signup still
 * completes. **An analytics failure must never take down a signup** — the user row
 * exists by the time this runs, and discarding it for a telemetry problem would
 * turn a metrics gap into an auth outage.
 *
 * The hook that calls this runs inside `databaseHooks.user.create.after`.
 * Testing that means driving the auth instance; testing this is a call with a
 * capture double. **A test that drives the auth instance to reach a three-line
 * analytics call is a test of better-auth**, and the auth library is not where
 * the risk is.
 */
export async function recordFunnelSignup(
  user: { id: string; emailVerified?: boolean },
  capture: (
    event: string,
    properties: Record<string, unknown>,
  ) => Promise<void>,
): Promise<void> {
  try {
    await capture(FUNNEL_EVENTS.signup, {
      email_verified: user.emailVerified === true,
    });
  } catch {
    // Swallowed deliberately, and deliberately without a log line either: a
    // capture failure on the signup path would otherwise write a log entry for
    // every user created whenever PostHog is down, which is a different outage
    // with the same cause.
  }
}
