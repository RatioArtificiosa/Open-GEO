import { expect, test } from "@playwright/test";
import {
  attachDomainPerfMetrics,
  attachJsonArtifact,
  applyFilters,
  closeFilters,
  ensureFiltersOpen,
  expectPageResponsive,
  getDomainPerfMetrics,
  installDomainPerfProbe,
  openDomainOverview,
  openFilters,
  resetDomainPerfMetrics,
  switchDomainTab,
  type DomainPerfMetrics,
  typeIntoDraftInput,
  waitForDomainRows,
} from "./domain-overview-test-utils";

const CPU_THROTTLE_RATE = Number(process.env.DOMAIN_FILTER_CPU_THROTTLE ?? 6);

/**
 * How much slower this machine is than the reference.
 *
 * **The budgets below are wall-clock, and a wall-clock number is a property of the
 * machine it was measured on.** That is why this spec was absent from CI: a
 * two-and-a-half-second action budget measured on a developer laptop is a coin-flip
 * on a shared runner at six times CPU throttle, so the suite either failed always
 * or had to be skipped — and a skipped suite has zero value while reading as
 * coverage.
 *
 * A multiplier, not a different set of numbers: the budgets stay the ones a human
 * maintains locally, and a slower machine scales them. `1` is the default so local
 * behaviour is unchanged. CI sets a documented generous value.
 *
 * **Scale multiplies, never replaces.** A caller who sets an absolute budget *and* a
 * scale gets both, because the absolute override is the narrower declaration and
 * there is no reason for the scale to silently undo it.
 */
function budgetScale(): number {
  const raw = process.env.DOMAIN_FILTER_BUDGET_SCALE;
  if (raw === undefined || raw.trim() === "") return 1;

  const parsed = Number(raw);
  /**
   * **A non-numeric scale would be the worst possible bug here.**
   *
   * `Number("abc")` is `NaN`, and `NaN > measuredMs` is `false` for every input,
   * so every budget check would pass on a green run while checking nothing at all —
   * a perf spec that can never fail is worse than no spec, because it reads as
   * coverage.
   *
   * So a value that does not parse to a finite number above zero is a hard error at
   * load, naming the variable and the value, rather than a silent fallback to the
   * local default. A typo should not look like a decision.
   */
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(
      `DOMAIN_FILTER_BUDGET_SCALE must parse to a number >= 1, got ${JSON.stringify(raw)}. ` +
        `Unset it to use the local budgets unscaled.`,
    );
  }
  return parsed;
}

const BUDGET_SCALE = budgetScale();

/** Apply the machine factor to one baseline budget. */
const scaled = (baseline: number) => Math.round(baseline * BUDGET_SCALE);

const PERF_BUDGETS = {
  actionMs: scaled(Number(process.env.DOMAIN_FILTER_ACTION_MS ?? 2_500)),
  maxLongTaskMs: scaled(
    Number(process.env.DOMAIN_FILTER_MAX_LONG_TASK_MS ?? 1_000),
  ),
  maxRafGapMs: scaled(
    Number(process.env.DOMAIN_FILTER_MAX_RAF_GAP_MS ?? 1_500),
  ),
  maxInputMs: scaled(Number(process.env.DOMAIN_FILTER_MAX_INPUT_MS ?? 4_000)),
  totalLongTaskMs: scaled(
    Number(process.env.DOMAIN_FILTER_TOTAL_LONG_TASK_MS ?? 8_000),
  ),
};

type PerfCheckpoint =
  | {
      label: string;
      metrics: DomainPerfMetrics;
    }
  | {
      label: string;
      error: string;
    };

type DomainDebugEntry = {
  type: string;
  text: string;
  parsed: unknown;
};

test.describe("Domain Overview filter performance", () => {
  test("captures main-thread stalls in the applied-filter edit flow", async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(browserName !== "chromium", "CPU throttling requires CDP");
    test.setTimeout(120_000);

    await installDomainPerfProbe(page);
    await page.addInitScript(() => {
      window.localStorage.setItem("debug:domain-overview", "1");
    });
    const domainDebugLog: DomainDebugEntry[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (!text.startsWith("[domain-debug]")) return;
      const raw = text.slice("[domain-debug]".length).trim();
      domainDebugLog.push({
        type: message.type(),
        text,
        parsed: parseDomainDebugMessage(raw),
      });
    });
    const client = await page.context().newCDPSession(page);
    await client.send("Emulation.setCPUThrottlingRate", {
      rate: CPU_THROTTLE_RATE,
    });

    const checkpoints: PerfCheckpoint[] = [];
    let finalMetrics: DomainPerfMetrics | null = null;
    let flowError: unknown;
    const captureCheckpoint = async (label: string) => {
      checkpoints.push({
        label,
        metrics: await withDeadline(
          getDomainPerfMetrics(page),
          2_000,
          `Timed out reading perf metrics for ${label}`,
        ),
      });
    };

    try {
      await openDomainOverview(page, "pages");
      await waitForDomainRows(page, "Top Pages");
      await resetDomainPerfMetrics(page);
      await captureCheckpoint("ready on Top Pages");

      await openFilters(page);
      await closeFilters(page);
      await openFilters(page);
      await closeFilters(page);
      await openFilters(page);
      await captureCheckpoint("toggled Top Pages filters");

      await typeIntoDraftInput(
        page,
        page.getByPlaceholder("Min").nth(0),
        "10",
        "Pages Traffic min",
        {
          actionTimeoutMs: PERF_BUDGETS.actionMs,
          cdpSession: client,
          inputLatencyBudgetMs: PERF_BUDGETS.maxInputMs,
          recordPerf: true,
        },
      );
      await applyFilters(page, "pMinTraffic", "10");
      await captureCheckpoint("applied Pages Traffic min");

      await ensureFiltersOpen(page, "Include Page Terms");
      await typeIntoDraftInput(
        page,
        page.getByPlaceholder("Max").nth(1),
        "50",
        "Pages Keywords max",
        {
          actionTimeoutMs: PERF_BUDGETS.actionMs,
          cdpSession: client,
          inputLatencyBudgetMs: PERF_BUDGETS.maxInputMs,
          recordPerf: true,
        },
      );
      await expect(page.getByText("unapplied")).toBeVisible();
      await expectPageResponsive(page, "after editing Pages Keywords max");
      await captureCheckpoint("edited Pages Keywords max");

      await switchDomainTab(page, "keywords");
      await waitForDomainRows(page, "Top Keywords");
      await openFilters(page);
      await typeIntoDraftInput(
        page,
        page.getByPlaceholder("Max").nth(1),
        "5000",
        "Keywords Volume max",
        {
          actionTimeoutMs: PERF_BUDGETS.actionMs,
          cdpSession: client,
          inputLatencyBudgetMs: PERF_BUDGETS.maxInputMs,
          recordPerf: true,
        },
      );
      await expect(page.getByText("unapplied")).toBeVisible();
      await expectPageResponsive(page, "after editing Keywords Volume max");
    } catch (error) {
      flowError = error;
      checkpoints.push({
        label: "flow error",
        error: getErrorMessage(error),
      });
    } finally {
      if (flowError) {
        checkpoints.push({
          label: "final metrics",
          error:
            "Skipped after renderer stall to preserve the original failure",
        });
      } else {
        finalMetrics = await withDeadline(
          getDomainPerfMetrics(page),
          2_000,
          "Timed out reading final perf metrics",
        ).catch((error: unknown) => {
          checkpoints.push({
            label: "final metrics",
            error: getErrorMessage(error),
          });
          return null;
        });
      }
      await attachJsonArtifact(
        testInfo,
        "domain-filter-perf-checkpoints.json",
        checkpoints,
      );
      await attachJsonArtifact(
        testInfo,
        "domain-filter-debug-log.json",
        domainDebugLog,
      );
      if (finalMetrics) {
        await attachDomainPerfMetrics(testInfo, finalMetrics);
      }
      await withDeadline(
        client.send("Emulation.setCPUThrottlingRate", { rate: 1 }),
        2_000,
        "Timed out resetting CPU throttling",
      ).catch(() => undefined);
    }

    if (flowError) throw flowError;
    if (!finalMetrics) throw new Error("Perf metrics were not collected");

    console.info(
      "[domain-filter-perf]",
      JSON.stringify(summarizeMetrics(finalMetrics)),
    );

    expect(finalMetrics.errors, "browser console/runtime errors").toEqual([]);
    expect(
      finalMetrics.maxInputDuration,
      "slowest measured input",
    ).toBeLessThan(PERF_BUDGETS.maxInputMs);
    expect(finalMetrics.maxLongTaskDuration, "slowest long task").toBeLessThan(
      PERF_BUDGETS.maxLongTaskMs,
    );
    expect(
      finalMetrics.totalLongTaskDuration,
      "total long-task time",
    ).toBeLessThan(PERF_BUDGETS.totalLongTaskMs);
    expect(finalMetrics.maxRafGap, "largest animation-frame gap").toBeLessThan(
      PERF_BUDGETS.maxRafGapMs,
    );
  });
});

function summarizeMetrics(metrics: DomainPerfMetrics) {
  return {
    maxInputDuration: Math.round(metrics.maxInputDuration),
    maxLongTaskDuration: Math.round(metrics.maxLongTaskDuration),
    totalLongTaskDuration: Math.round(metrics.totalLongTaskDuration),
    maxRafGap: Math.round(metrics.maxRafGap),
    longTaskCount: metrics.longTasks.length,
    rafGapCount: metrics.rafGaps.length,
    inputEvents: metrics.inputEvents.map((event) => ({
      label: event.label,
      duration: Math.round(event.duration),
    })),
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseDomainDebugMessage(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
