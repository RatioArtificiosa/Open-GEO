import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDemoModeCache } from "@/server/lib/demo-mode";
import { demoResponseFor } from "./demo-fixtures";

const MENTIONS_SEARCH = "/v3/ai_optimization/llm_mentions/search/live";
const TARGET_METRICS = "/v3/ai_optimization/llm_mentions/target_metrics/live";

beforeEach(() => {
  resetDemoModeCache();
  delete process.env.DEMO_MODE;
});

afterEach(() => {
  delete process.env.DEMO_MODE;
  resetDemoModeCache();
});

/**
 * Fixtures return `Record<string, unknown>`, so every read needs narrowing. These
 * helpers narrow explicitly instead of asserting a narrower type, which keeps the
 * repo's `no-unsafe-type-assertion` rule satisfied without suppressions.
 */
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return { ...value };
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function firstResult(path: string): Promise<Record<string, unknown>> {
  const envelope = record(await demoResponseFor(path));
  const firstTask = record(array(envelope.tasks)[0]);
  return record(array(firstTask.result)[0]);
}

describe("demo fixtures", () => {
  it("returns nothing when demo mode is off, so real calls proceed", async () => {
    expect(await demoResponseFor(MENTIONS_SEARCH)).toBeNull();
  });

  it("fixtures an AI mentions search with a full DataForSEO envelope", async () => {
    process.env.DEMO_MODE = "true";
    const envelope = record(await demoResponseFor(MENTIONS_SEARCH));
    const task = record(array(envelope.tasks)[0]);
    expect(num(task.status_code)).toBe(20000);
    expect(str(task.status_message)).toBe("Ok.");

    const result = await firstResult(MENTIONS_SEARCH);
    expect(num(result.total_count)).toBe(1284);

    const items = array(result.items).map(record);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toHaveProperty("ai_search_volume");
    expect(items[0]).toHaveProperty("sources");
  });

  it("keeps platform demand figures distinct, as real data does", async () => {
    process.env.DEMO_MODE = "true";
    const result = await firstResult(TARGET_METRICS);
    const metrics = record(result.aggregated_metrics);
    const total = record(metrics.total);
    const platform = record(array(metrics.platform)[0]);

    expect(num(total.mentions)).toBe(num(platform.mentions));
    // Mirrors the documented ChatGPT example, which is far lower than the Google
    // AIO figure for the same query. A fixture that invented a single blended
    // number would teach exactly the wrong lesson.
    expect(num(total.ai_search_volume)).toBe(63850);
  });

  it("returns null for an unfixtured path so a working call never becomes an error", async () => {
    process.env.DEMO_MODE = "true";
    expect(
      await demoResponseFor("/v3/merchant/amazon/product/live"),
    ).toBeNull();
  });

  it("carries a numeric cost for shape parity; the metering layer must skip it", async () => {
    process.env.DEMO_MODE = "true";
    const envelope = record(await demoResponseFor(MENTIONS_SEARCH));
    const task = record(array(envelope.tasks)[0]);
    // The field exists so the envelope matches the real one, but demo responses
    // are never metered. Asserted here so a future change cannot bill by accident.
    expect(typeof task.cost).toBe("number");
  });
});
