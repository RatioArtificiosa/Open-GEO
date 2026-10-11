/**
 * The conversion funnel's event names, in one place.
 *
 * ## Why they are declared rather than written at each call site
 *
 * CL-617 names four stages — free-tool → signup → paid, GEO activation, and the
 * "wow" moment of viewing the citation gap. Those names live in a planning
 * document; the events lived in the code as string literals at their call sites.
 * The two could disagree, and nothing would notice until somebody built a funnel
 * and found a hole in the middle of it.
 *
 * So the names are declared here and the call sites reference them. **A funnel
 * that cannot be assembled reports zero at a stage, which is the same shape as a
 * checklist that has drifted from the tree** — silent, and only visible to
 * someone who knew to look.
 *
 * ## Which stages are covered, and which are not
 *
 * The marketing site already fires the free-tool stage under Plausible. The app's
 * own two stages were missing entirely, and they are the ones a funnel is
 * assembled from: first GEO dashboard, and the citation gap.
 *
 * **Not declared here:** every other event the app fires. Those stay at their
 * call sites and are enumerated by `scripts/check-analytics-funnel.mjs`, which
 * scans for them rather than duplicating them — a copy rots, a scanner does not.
 *
 * This module is a plain declaration rather than a wrapper around the capture
 * helpers, because the shared module cannot reach both: the server helper takes
 * an object, the client one takes positional arguments, and unifying them here
 * would be a layer that exists to satisfy a symmetry. The names are the part
 * that must be shared; the calls are not.
 */

/**
 * The funnel's stage names.
 *
 * A `const` object rather than a union of literals, so a typo at a call site is a
 * compile error rather than a silently different event in PostHog — which is
 * indistinguishable from a stage that never fires.
 */
export const FUNNEL_EVENTS = {
  /** A signup completed. The app's first event for a user. */
  signup: "signup",
  /** A customer's billing state changed, per the Autumn webhook. */
  planChanged: "billing_plan_changed",
  /** The first time a user saw a GEO dashboard. Activation. */
  geoActivation: "geo_activation_first_dashboard",
  /** The moment a user viewed the citation gap. The wow. */
  citationGapViewed: "geo_citation_gap_viewed",
} as const;

export type FunnelEvent = (typeof FUNNEL_EVENTS)[keyof typeof FUNNEL_EVENTS];

/**
 * Every funnel event the app owns, for the gate that asserts each one is wired.
 *
 * The free-tool stage is deliberately absent: it fires on the marketing site
 * under Plausible, not PostHog, and the gate's scan is of this repository. A
 * stage listed here that nothing fires would fail the gate for the wrong reason,
 * which teaches the next reader to distrust it.
 */
export const ALL_FUNNEL_EVENTS: readonly FunnelEvent[] =
  Object.values(FUNNEL_EVENTS);
