import { usePrefersReducedMotion } from "@/client/lib/usePrefersReducedMotion";

/**
 * The motion props every animated series spreads, so the numbers live in one
 * place and agree with DESIGN.md §7 — *"Chart first paint | 400ms | ease-out"*.
 *
 * **Charts animate in JavaScript, not CSS.** Recharts drives its transitions
 * through `requestAnimationFrame`, so the `prefers-reduced-motion` block in
 * `app.css` — which zeroes CSS durations — cannot reach them. Without this hook
 * a reader who asked their system to stop moving things would still get every
 * line drawing in, which is the same defect the stylesheet rule exists to fix,
 * one engine over.
 *
 * The shape is constant rather than conditional so the spread is type-stable;
 * when motion is reduced, `isAnimationActive: false` is what takes effect and the
 * duration is simply never read.
 */
export function useChartMotion(): {
  isAnimationActive: boolean;
  animationDuration: number;
  animationEasing: "ease-out";
} {
  const reduced = usePrefersReducedMotion();
  return {
    isAnimationActive: !reduced,
    animationDuration: 400,
    animationEasing: "ease-out",
  };
}
