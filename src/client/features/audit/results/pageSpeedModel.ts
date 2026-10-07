/**
 * Display rules for the page-speed panel.
 *
 * ## The phases add up; the resources do not
 *
 * The vendor reports five timings for the main document, and in its own sample they sum exactly
 * to `duration_time` (13 + 18 + 0 + 0 + 5 = 36). So a **stacked** bar for the phases is honest:
 * each segment is a real share of the page's own load.
 *
 * The resources are the opposite. They overlap — a stylesheet and the font it needs can be in
 * flight at once — so their durations do **not** sum to anything meaningful, and the panel shows
 * them as a ranked list rather than as another bar. Drawing them as a stack would imply a total
 * that does not exist, and the number would be larger than the page it came from.
 */

type PhaseSegment = {
  label: string;
  /** Milliseconds, or null when the vendor did not report this phase. */
  ms: number | null;
  /** Share of the document's duration, 0 to 1, or null when there is no denominator. */
  share: number | null;
  /** daisyUI classes for the bar segment. */
  className: string;
};

type PhaseInput = {
  connectionTimeMs: number | null;
  timeToSecureConnectionMs: number | null;
  /** Time to first byte. */
  waitingTimeMs: number | null;
  downloadTimeMs: number | null;
  durationTimeMs: number | null;
};

/**
 * The four phases of the main document, in the order they happen.
 *
 * A null phase is kept with a null share rather than dropped: "the vendor did not report this"
 * and "this took no time" are different, and a bar that omitted the first would silently
 * renormalise the second.
 */
export function phaseSegments(page: PhaseInput): PhaseSegment[] {
  const segments: Array<Pick<PhaseSegment, "label" | "ms" | "className">> = [
    {
      label: "Connect",
      ms: page.connectionTimeMs,
      className: "bg-base-content/30",
    },
    {
      label: "Secure connection",
      ms: page.timeToSecureConnectionMs,
      className: "bg-base-content/50",
    },
    {
      label: "Waiting (TTFB)",
      ms: page.waitingTimeMs,
      className: "bg-warning",
    },
    { label: "Download", ms: page.downloadTimeMs, className: "bg-success" },
  ];

  const total = page.durationTimeMs;
  return segments.map((segment) => ({
    ...segment,
    share:
      total !== null && total > 0 && segment.ms !== null
        ? segment.ms / total
        : null,
  }));
}
