import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * The reader's motion setting, as a value React can branch on.
 *
 * **The stylesheet rule is not enough.** `app.css` zeroes CSS animation and
 * transition durations under `prefers-reduced-motion`, which covers every
 * Tailwind `transition-*`, `animate-spin` and `animate-pulse` — but **Recharts
 * and the count-up animate in JavaScript, through `requestAnimationFrame`**, and
 * a media query cannot reach them. A JS-driven animation that ignores the
 * setting is the same defect with a different engine, so it reads the same
 * query here.
 *
 * Defaults to `false` when there is no `window` (SSR) and subscribes to changes,
 * because a reader can flip the setting without reloading and the next render
 * should honour it.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const list = window.matchMedia(QUERY);
    setReduced(list.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
