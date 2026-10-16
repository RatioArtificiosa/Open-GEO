/**
 * The VisibilityForecast render decision, as a pure function.
 *
 * CL-501-web's whole job is refusing to show numbers it cannot stand behind —
 * pending, fault, refusal, thin sample, missing direction, skipped runs — so
 * the branch logic is extracted here where tests drive it on the real path,
 * rather than living only in JSX a suite cannot reach (the public vitest env
 * is node, no DOM). The component calls this and renders what it says; the
 * panel-owned copy lives in FORECAST_COPY below and is pinned byte for byte
 * by VisibilityForecast.states.test.ts.
 *
 * Three outcomes at the top, never two: loading and fault are their own
 * states because neither is evidence about visibility, and "ready" carries
 * one boolean per optional block. Collapsing "leave out" into any other
 * value is how a refusal silently becomes a confident number.
 */
/**
 * The panel's own sentences, as values the tests drive.
 *
 * Whitespace is single-spaced exactly as JSX collapses it at render: these
 * strings are what the reader sees, so the tests assert them byte for byte.
 * Change a sentence here and both the suite and the screen move together —
 * that is the point. Server-owned sentences are deliberately absent.
 */
export const FORECAST_COPY = {
  loading: "Loading forecast",
  fault:
    "This panel could not be read. That is a fault here, not a statement about your visibility.",
  refusal:
    "A mention rate is only meaningful with its sample size, so this panel will not show a percentage it cannot stand behind. The reason is below.",
  thinSample: "Too few prompts for a rate to mean anything yet.",
  narrowSample: "More runs will narrow this.",
} as const;

export type ForecastCurrent = {
  basedOn: number;
  rate: number | null;
  low: number | null;
  high: number | null;
  confidence: string;
};

type ForecastPanelState =
  | { kind: "loading" }
  | { kind: "fault" }
  | {
      kind: "ready";
      /** Rate block renders: measured sample behind a non-null rate. */
      showRate: boolean;
      /** Interval renders: both bounds present. One bound is not a spread. */
      showInterval: boolean;
      /**
       * Confidence sentence: "none" names too-few-prompts, "narrow" names
       * more-runs-needed, null renders nothing (high confidence needs no
       * caveat beside a stated interval).
       */
      confidenceNote: "none" | "narrow" | null;
      /** Server note renders verbatim. */
      showNote: boolean;
      /** Direction number renders; absent reads the server sentence alone. */
      directionPresent: boolean;
      /** Skipped-runs disclosure renders. */
      showSkipped: boolean;
    };

type ReadyForecastPanelState = Extract<ForecastPanelState, { kind: "ready" }>;

type ReadyPanelInput = {
  isPending: false;
  isError: false;
  current: ForecastCurrent | null | undefined;
  hasNote: boolean;
  directionPerWeek: number | null;
  skipped: number;
};

type PanelInput = {
  isPending: boolean;
  isError: boolean;
  current: ForecastCurrent | null | undefined;
  hasNote: boolean;
  directionPerWeek: number | null;
  skipped: number;
};

export function resolveForecastPanelState(
  input: ReadyPanelInput,
): ReadyForecastPanelState;
export function resolveForecastPanelState(
  input: PanelInput,
): ForecastPanelState;
export function resolveForecastPanelState(
  input: PanelInput,
): ForecastPanelState {
  if (input.isPending) return { kind: "loading" };
  if (input.isError) return { kind: "fault" };
  const current = input.current ?? null;
  if (current === null) {
    return {
      kind: "ready",
      showRate: false,
      showInterval: false,
      confidenceNote: null,
      showNote: input.hasNote,
      directionPresent: input.directionPerWeek !== null,
      showSkipped: input.skipped > 0,
    };
  }
  const showRate = current.basedOn > 0 && current.rate !== null;
  return {
    kind: "ready",
    showRate,
    showInterval: showRate && current.low !== null && current.high !== null,
    confidenceNote:
      showRate && current.confidence !== "high"
        ? current.confidence === "none"
          ? "none"
          : "narrow"
        : null,
    showNote: input.hasNote,
    directionPresent: input.directionPerWeek !== null,
    showSkipped: input.skipped > 0,
  };
}
