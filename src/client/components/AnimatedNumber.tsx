import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/client/lib/usePrefersReducedMotion";

/** DESIGN.md §7 — "Value change (number tick) | 240ms | cubic-bezier(0.2, 0, 0, 1)". */
const DURATION_MS = 240;

/** One axis of a cubic-bezier, evaluated at `t`. Module scope: it captures nothing. */
function curveAt(t: number, a1: number, a2: number): number {
  return 3 * a1 * t * (1 - t) ** 2 + 3 * a2 * t ** 2 * (1 - t) + t ** 3;
}

/**
 * A cubic-bezier, solved rather than approximated.
 *
 * §7 names an exact curve, and "roughly ease-out" is the kind of quiet drift
 * this repository refuses elsewhere: a curve that is close is a curve nobody can
 * check agrees with the document. Binary search on `x` is enough at this scale —
 * the sampler runs at most a few hundred times over 240ms.
 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  return (x: number) => {
    let low = 0;
    let high = 1;
    let t = x;
    for (let i = 0; i < 24; i += 1) {
      t = (low + high) / 2;
      if (curveAt(t, x1, x2) < x) low = t;
      else high = t;
    }
    return curveAt(t, y1, y2);
  };
}

const EASE = cubicBezier(0.2, 0, 0, 1);

/**
 * A number that counts to its new value instead of jumping to it.
 *
 * §14.5 asks for count-up numbers, and §7's rule is that motion **explains a
 * change** — a value that animates from what it was to what it is now shows the
 * reader that it moved. It is not an entrance effect: the first paint renders
 * the value immediately, because animating from zero would report a number that
 * was never true.
 *
 * **Integer-only on purpose.** Its one call site is the visibility score, which
 * is an integer out of 100; a formatted or decimal value would need a formatter
 * argument, and inventing one before there is a caller is the guess this repo
 * avoids. Widen it when a second caller needs it.
 *
 * **Reduced motion renders the value instantly** — via the hook, because this
 * animates through `requestAnimationFrame` and the stylesheet cannot reach it.
 */
export function AnimatedNumber({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);

  useEffect(() => {
    if (reduced) {
      fromRef.current = value;
      setShown(value);
      return;
    }

    const from = fromRef.current;
    const delta = value - from;
    if (delta === 0) return;

    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / DURATION_MS);
      setShown(Math.round(from + delta * EASE(progress)));
      if (progress < 1) frame = requestAnimationFrame(step);
      else fromRef.current = value;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, reduced]);

  return <span className={className}>{shown}</span>;
}
