import {
  describeVisibilityScore,
  type VisibilityScore,
} from "./visibility-score";
import { AnimatedNumber } from "@/client/components/AnimatedNumber";

/**
 * The score ring.
 *
 * A score is a summary; the receipts are the product. So this renders the number
 * *and* the table that produced it, with every component carrying the sentence a
 * reader can check it against, and every missing component named rather than
 * silently contributing nothing.
 *
 * One ring per platform, never one combined ring — the same rule as every other
 * metric on this page, and the reason CL-135 exists.
 */

const PLATFORM_LABELS: Record<string, string> = {
  chat_gpt: "ChatGPT",
  google_ai_overview: "Google AI Overview",
  gemini: "Gemini",
  perplexity: "Perplexity",
};

function labelFor(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

/**
 * The ring's geometry, as a stroke-dasharray.
 *
 * Pure and exported so the one claim that matters — that the arc is proportional
 * to the score — can be tested without a DOM. A ring that draws 100% at any
 * score is the visual equivalent of a confident wrong number.
 */
export function arcFor(score: number): { dash: string; offset: number } {
  // `Number.isFinite` rather than a `Math.min`/`Math.max` clamp: NaN survives
  // both, and `NaN NaN` as a `strokeDasharray` renders no circle at all — a
  // broken chart rather than an absent number, and the reader cannot tell which
  // happened.
  const bounded = Number.isFinite(score)
    ? Math.min(100, Math.max(0, score))
    : 0;
  return { dash: `${bounded} ${100 - bounded}`, offset: 100 - bounded };
}

export function ScoreRing({
  score,
  onSelectComponent,
}: {
  score: VisibilityScore;
  /** Click-through to the panel that produced a component's number. */
  onSelectComponent?: (componentId: string) => void;
}) {
  const summary = describeVisibilityScore(score);

  if (score.score === null) {
    return (
      <section className="rounded-xl border border-base-300 bg-base-100 p-4">
        <h3 className="text-base font-semibold">
          {labelFor(score.platform)} visibility score
        </h3>
        <p className="text-base-content/60 text-sm">
          Not enough measured yet to score this brand. The score needs at least
          one component with data, and it is computed per platform — combining
          them would produce a number that means nothing.
        </p>
      </section>
    );
  }

  const { dash, offset } = arcFor(score.score);

  return (
    <section className="rounded-xl border border-base-300 bg-base-100 p-4">
      <h3 className="text-base font-semibold">
        {labelFor(score.platform)} visibility score
      </h3>

      <div className="mt-3 flex items-center gap-4">
        <svg
          viewBox="0 0 36 36"
          className="size-24 shrink-0 -rotate-90"
          role="img"
          aria-label={`${score.score} out of 100 on ${labelFor(score.platform)}`}
        >
          <circle
            cx="18"
            cy="18"
            r="15.9155"
            fill="none"
            strokeWidth="3"
            className="stroke-base-300"
          />
          <circle
            cx="18"
            cy="18"
            r="15.9155"
            fill="none"
            strokeWidth="3"
            strokeDasharray={dash}
            strokeDashoffset={offset}
            className="stroke-[var(--color-accent,#F59E0B)]"
            strokeLinecap="round"
          />
        </svg>

        <div className="min-w-0">
          {/* §14.5's count-up. The paragraph is `aria-hidden` and the svg above
              carries the label, so a screen reader hears the value once rather
              than every tick. */}
          <p className="text-3xl font-semibold tabular-nums" aria-hidden="true">
            <AnimatedNumber value={score.score} />
          </p>
          <p className="text-base-content/70 text-sm">{summary}</p>
        </div>
      </div>

      <table className="mt-4 w-full text-xs">
        <caption className="sr-only">
          Score components and the evidence behind each one
        </caption>
        <thead>
          <tr className="text-base-content/60 text-left">
            <th className="font-normal">Component</th>
            <th className="font-normal">Value</th>
            <th className="font-normal">Weight</th>
            <th className="font-normal">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {score.components.map((component) => (
            <tr key={component.id} className="align-top">
              <td className="py-1 pr-2">
                {onSelectComponent ? (
                  <button
                    type="button"
                    className="link link-hover"
                    onClick={() => onSelectComponent(component.id)}
                  >
                    {component.id}
                  </button>
                ) : (
                  component.id
                )}
              </td>
              <td
                className="py-1 pr-2 tabular-nums"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {/* Null renders as an em dash, never as 0. A component we could
                    not measure is not a component that scored zero. */}
                {component.value === null ? "—" : component.value}
              </td>
              <td className="py-1 pr-2 tabular-nums">
                {Math.round(component.weight * 100)}%
              </td>
              <td className="text-base-content/70 py-1">
                {component.evidence}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
