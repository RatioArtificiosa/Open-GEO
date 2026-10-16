import { describe, expect, it, vi } from "vitest";
import type { MilestoneStorage } from "./milestone-events";
import {
  CITATION_GAP_KEY,
  clearMilestoneMarks,
  fireMilestoneOnce,
  GEO_ACTIVATION_KEY,
} from "./milestone-events";

/**
 * The once-per-milestone guard behind the funnel's client stages.
 *
 * `geoActivation` and `citationGapViewed` fire from effects, and an effect
 * without this guard fires on every mount — a counter that grows with
 * refreshes. These assertions drive the guard with a reporting double across
 * simulated remounts: call, call again, and only the first may fire.
 */

function memoryStorage(initial: Record<string, string> = {}): MilestoneStorage {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

describe("fireMilestoneOnce", () => {
  it("fires on first view and stays silent on remount", () => {
    const storage = memoryStorage();
    const fire = vi.fn();
    expect(fireMilestoneOnce(storage, "geoActivationRecorded", fire)).toBe(
      true,
    );
    expect(fireMilestoneOnce(storage, "geoActivationRecorded", fire)).toBe(
      false,
    );
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("treats each milestone key independently", () => {
    const storage = memoryStorage();
    const fire = vi.fn();
    fireMilestoneOnce(storage, "a", fire);
    fireMilestoneOnce(storage, "b", fire);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("still fires when storage is unavailable, because the page matters more", () => {
    const broken: MilestoneStorage = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
      removeItem: () => {
        throw new Error("private mode");
      },
    };
    const fire = vi.fn();
    expect(fireMilestoneOnce(broken, "k", fire)).toBe(true);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("treats a pre-marked key as already converted", () => {
    const storage = memoryStorage({ k: "1" });
    const fire = vi.fn();
    expect(fireMilestoneOnce(storage, "k", fire)).toBe(false);
    expect(fire).not.toHaveBeenCalled();
  });
});

describe("clearMilestoneMarks", () => {
  it("forgets every milestone so the next user starts clean", () => {
    const storage = memoryStorage({
      [GEO_ACTIVATION_KEY]: "1",
      [CITATION_GAP_KEY]: "1",
      unrelated: "keep",
    });
    clearMilestoneMarks(storage);
    const fire = vi.fn();
    expect(fireMilestoneOnce(storage, GEO_ACTIVATION_KEY, fire)).toBe(true);
    expect(fireMilestoneOnce(storage, CITATION_GAP_KEY, fire)).toBe(true);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("never throws, because logout must not fail over telemetry", () => {
    const broken: MilestoneStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => {
        throw new Error("private mode");
      },
    };
    expect(() => clearMilestoneMarks(broken)).not.toThrow();
  });
});
