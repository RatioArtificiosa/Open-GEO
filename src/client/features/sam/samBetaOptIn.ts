import { useSyncExternalStore } from "react";
import { captureClientEvent } from "@/client/lib/posthog";

// Sam is opt-in while in beta: the chat route shows SamBetaGate until the user
// explicitly chooses to continue. Per browser on purpose — this is a temporary
// nudge toward the MCP path, not an account setting worth a schema change.
const STORAGE_KEY = "sam-beta-opt-in";

// A tiny external store so the chat panel and the sidebar's Chat tab flip
// together the moment the user opts in.
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const read = () => localStorage.getItem(STORAGE_KEY) === "1";

export function optInToSamBeta() {
  localStorage.setItem(STORAGE_KEY, "1");
  captureClientEvent("sam:beta_opt_in");
  listeners.forEach((listener) => listener());
}

// The app tree is client-only (see root ClientOnly), so the server snapshot is
// never rendered; it only has to exist.
export function useSamBetaOptIn(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
