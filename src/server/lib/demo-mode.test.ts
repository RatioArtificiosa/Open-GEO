import { describe, expect, it, beforeEach } from "vitest";
import {
  asDemo,
  isDemoMode,
  resetDemoModeCache,
  type DemoEnvelope,
} from "./demo-mode";

beforeEach(() => {
  resetDemoModeCache();
  delete process.env.DEMO_MODE;
});

describe("demo mode", () => {
  it("is off by default", async () => {
    expect(await isDemoMode()).toBe(false);
  });

  it("turns on for an explicit true", async () => {
    process.env.DEMO_MODE = "true";
    expect(await isDemoMode()).toBe(true);
  });

  it("tolerates casing and surrounding whitespace", async () => {
    process.env.DEMO_MODE = "  TRUE  ";
    expect(await isDemoMode()).toBe(true);
  });

  it("stays off for any other value, including 'false' and '1'", async () => {
    process.env.DEMO_MODE = "false";
    expect(await isDemoMode()).toBe(false);
    resetDemoModeCache();
    process.env.DEMO_MODE = "1";
    expect(await isDemoMode()).toBe(false);
  });

  it("caches within the process and can be reset", async () => {
    process.env.DEMO_MODE = "true";
    expect(await isDemoMode()).toBe(true);
    process.env.DEMO_MODE = "false";
    expect(await isDemoMode()).toBe(true); // cached
    resetDemoModeCache();
    expect(await isDemoMode()).toBe(false);
  });

  it("flags wrapped demo data so the UI can badge it", () => {
    const wrapped: DemoEnvelope<{ mentions: number }> = asDemo({
      mentions: 1234,
    });
    expect(wrapped.demo).toBe(true);
    expect(wrapped.data.mentions).toBe(1234);
  });
});
