import { useState } from "react";
import { trackTool } from "@/lib/free-tools/analytics";
import type { ToolStatus } from "@/lib/free-tools/form";

/**
 * The submit cycle every API-backed free tool shares: status machine, error
 * message and Plausible events. ToolForm supplies the verified token.
 */
export function useToolRun<T>(tool: string, path: string) {
  const [status, setStatus] = useState<ToolStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [result, setResult] = useState<T | null>(null);

  const run = async (body: Record<string, unknown>, turnstileToken: string) => {
    if (!turnstileToken) return;
    setStatus("loading");
    setErrorMessage("");
    trackTool("tool_run", tool);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, turnstileToken }),
      });
      const data = (await res.json().catch(() => ({}))) as
        | T
        | { error?: string };
      if (!res.ok) {
        throw new Error(
          (data as { error?: string }).error || "Something went wrong",
        );
      }
      setResult(data as T);
      setStatus("done");
      trackTool("tool_result", tool);
    } catch (err) {
      setStatus("error");
      setErrorMessage(
        err instanceof Error ? err.message : "Something went wrong",
      );
    }
  };

  return { status, errorMessage, result, run };
}
