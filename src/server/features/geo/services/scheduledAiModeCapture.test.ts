/**
 * `runDueAiModeCaptures` — the nightly runner.
 *
 * **This file had no test while the module it wraps had eleven**, and that asymmetry
 * is the finding: `aiModeMonitor.test.ts` checks the cost arithmetic per keyword, and
 * nothing checked the *runner* that sums those results into the number the cron log
 * prints. So the runner summed `estimatedCostUsd` only, and the `actualCostUsd` the
 * monitor has reported since the billing fix was discarded one layer up — the same
 * shape as the two never-written tables this session found, one call stack away: a
 * value nobody reads.
 *
 * Every test here is about the aggregation, because that is what this module does.
 */
import { describe, expect, it, vi } from "vitest";
import { runDueAiModeCaptures } from "./scheduledAiModeCapture";

// Type-only: the runner takes both collaborators as injections, so the suite
// names their real types and substitutes its own implementations.
import type { runAiModeMonitor } from "./aiModeMonitor";

// `@/db` reads `env` at import time through this module, which only exists inside a
// worker. Every collaborator is injected below, so this only satisfies the import
// graph — the runner never touches a database here.
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const NOW = new Date("2026-10-01T03:00:00.000Z");

/**
 * Named from the module's own collaborators rather than from the optional injection
 * fields, for the reason the ETV suite needed it: `NonNullable` on a *conditional*
 * indexed access does not distribute, so the type comes out `Fn | undefined` and
 * `vi.fn<T>` rejects it.
 */
type NightResult = Awaited<ReturnType<typeof runAiModeMonitor>>;

/**
 * `projectsWatchingAiMode` is module-private, so the type is taken from the
 * **injection field** rather than from the function — and the optionality is
 * stripped by a conditional type rather than by `NonNullable<...>`, which does not
 * distribute over a conditional indexed access and yields `Fn | undefined`.
 */
type CapturedInput = NonNullable<Parameters<typeof runDueAiModeCaptures>[0]>;
type Watcher = Awaited<
  ReturnType<CapturedInput extends { fetchWatchers?: infer F } ? F : never>
>[number];

/** A watched prompt, with the fields the scheduler ranks on. */
const watchedPrompt = (keyword: string): Watcher["prompts"][number] => ({
  keyword,
  estimatedCostUsd: 0.004,
  observedChanges: 0,
  observations: 0,
});

/** A monitor result, with the two cost fields set independently. */
const result = (over: {
  captured?: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  failed?: Array<{ keyword: string; reason: string }>;
}): NightResult =>
  ({
    projectId: "p1",
    ran: true,
    skippedReason: null,
    captured: over.captured ?? 1,
    failed: over.failed ?? [],
    changes: [],
    estimatedCostUsd: over.estimatedCostUsd ?? 0.004,
    actualCostUsd: over.actualCostUsd ?? 0.004,
    summary: "",
  }) as NightResult;

const watcher = (projectId: string): Watcher => ({
  projectId,
  prompts: [watchedPrompt(`k-${projectId}`)],
  locationCode: 2840,
  languageCode: "en",
});

const run = (input: {
  watchers: Array<ReturnType<typeof watcher>>;
  results: NightResult[];
}) =>
  runDueAiModeCaptures({
    now: NOW,
    fetchWatchers: async () => input.watchers,
    runMonitor: async () => input.results.shift() ?? result({}),
  });

describe("runDueAiModeCaptures", () => {
  it("sums the vendor's cost beside the estimate, so a repriced endpoint shows", async () => {
    // **The defect this file exists for.** The runner summed only the estimate, so
    // the one figure that would reveal the $0.004 constant drifting was computed a
    // layer down and dropped on the way out.
    const report = await run({
      watchers: [watcher("p1")],
      results: [result({ estimatedCostUsd: 0.004, actualCostUsd: 0.0031 })],
    });

    expect(report.actualCostUsd).toBe(0.0031);
    expect(report.estimatedCostUsd).toBe(0.004);
    // **The drift is the point**, so it is asserted rather than merely available.
    expect(report.actualCostUsd).not.toBe(report.estimatedCostUsd);
  });

  it("sums both figures across projects rather than taking the last one", async () => {
    const report = await run({
      watchers: [watcher("p1"), watcher("p2")],
      results: [
        result({ estimatedCostUsd: 0.004, actualCostUsd: 0.004 }),
        result({ estimatedCostUsd: 0.004, actualCostUsd: 0.002 }),
      ],
    });

    expect(report.projectsVisited).toBe(2);
    expect(report.estimatedCostUsd).toBeCloseTo(0.008, 6);
    expect(report.actualCostUsd).toBeCloseTo(0.006, 6);
  });

  it("counts a project's failures as a count, and keeps the reasons per project", async () => {
    const report = await run({
      watchers: [watcher("p1"), watcher("p2")],
      results: [
        result({
          captured: 0,
          failed: [{ keyword: "k-p1", reason: "upstream exploded" }],
        }),
        result({ captured: 1 }),
      ],
    });

    expect(report.failed).toBe(1);
    expect(report.captured).toBe(1);
    // **The per-project list is the part a count cannot replace**: an operator needs
    // to know *which* keyword went unanswered, not how many.
    expect(report.projects[0]?.failed[0]?.keyword).toBe("k-p1");
  });

  it("reports zero visits and zero cost when nothing is being watched", async () => {
    // Nothing configured, nothing asked, nothing billed — the opt-in with no flag.
    const report = await run({ watchers: [], results: [] });

    expect(report.projectsVisited).toBe(0);
    expect(report.captured).toBe(0);
    expect(report.actualCostUsd).toBe(0);
    expect(report.estimatedCostUsd).toBe(0);
  });

  it("gives each project the full budget rather than a share of one night", async () => {
    // The division would make each project's ceiling depend on how many other
    // customers happen to be watching, which is the bug this rule exists to prevent.
    const report = await run({
      watchers: [watcher("p1"), watcher("p2"), watcher("p3")],
      results: [
        result({ estimatedCostUsd: 0.004 }),
        result({ estimatedCostUsd: 0.004 }),
        result({ estimatedCostUsd: 0.004 }),
      ],
    });

    // Three projects at $0.004 each, not one budget split three ways.
    expect(report.estimatedCostUsd).toBeCloseTo(0.012, 6);
    expect(report.captured).toBe(3);
  });

  it("bounds the sweep so one tick cannot fan out across every customer", async () => {
    const many = Array.from({ length: 40 }, (_, i) => watcher(`p${i}`));

    const report = await runDueAiModeCaptures({
      now: NOW,
      limitProjects: 3,
      fetchWatchers: async () => many,
      runMonitor: async () => result({}),
    });

    expect(report.projectsVisited).toBe(3);
    // **Every count derives from what actually ran**, so the reported spend is the
    // spend of three projects rather than of forty.
    expect(report.estimatedCostUsd).toBeCloseTo(0.012, 6);
  });
});
