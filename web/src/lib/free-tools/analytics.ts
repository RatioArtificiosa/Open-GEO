type PlausibleEvent = "tool_run" | "tool_result" | "tool_cta_click";

/**
 * Plausible is loaded lazily through the first-party proxy in __root.tsx, so
 * `window.plausible` may not exist yet (or at all, with an ad blocker). Every
 * call is optional — analytics must never break a tool.
 */
export function trackTool(event: PlausibleEvent, tool: string) {
  if (typeof window === "undefined") return;
  (
    window as unknown as {
      plausible?: (
        name: string,
        options?: { props?: Record<string, string> },
      ) => void;
    }
  ).plausible?.(event, { props: { tool } });
}
