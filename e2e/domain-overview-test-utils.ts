import { writeFile } from "node:fs/promises";
import {
  expect,
  type CDPSession,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

// Real .com suffix on purpose: form-submit validation (isValidDomainHost via
// tldts) rejects the reserved .example TLD, and these constants reach the one
// test that submits through the real form instead of URL navigation.
export const PRIMARY_TEST_DOMAIN = "primary.example.com";
export const SECONDARY_TEST_DOMAIN = "secondary.example.com";
const RESPONSIVE_TIMEOUT_MS = 1_500;
const INPUT_LATENCY_BUDGET_MS = 8_000;

type DomainTab = "keywords" | "pages";

type DomainLongTask = {
  name: string;
  startTime: number;
  duration: number;
};

type DomainRafGap = {
  startTime: number;
  duration: number;
};

type DomainInputEvent = {
  label: string;
  duration: number;
  time: number;
};

type DomainPerfState = {
  startedAt: number;
  longTasks: DomainLongTask[];
  rafGaps: DomainRafGap[];
  maxRafGap: number;
  inputEvents: DomainInputEvent[];
  errors: string[];
};

type WindowWithDomainPerf = Window &
  typeof globalThis & {
    __domainPerf?: DomainPerfState;
  };

export type DomainPerfMetrics = DomainPerfState & {
  url: string;
  userAgent: string;
  maxLongTaskDuration: number;
  totalLongTaskDuration: number;
  maxInputDuration: number;
};

export async function installDomainPerfProbe(page: Page) {
  await page.addInitScript(() => {
    const state: DomainPerfState = {
      startedAt: performance.now(),
      longTasks: [],
      rafGaps: [],
      maxRafGap: 0,
      inputEvents: [],
      errors: [],
    };
    const win = window as WindowWithDomainPerf;
    win.__domainPerf = state;

    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({
            name: entry.name,
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      // Long Tasks are Chromium-only. The rest of the probe still catches stalls.
    }

    let lastFrame = performance.now();
    const tick = (now: number) => {
      const gap = now - lastFrame;
      state.maxRafGap = Math.max(state.maxRafGap, gap);
      if (gap > 100) {
        state.rafGaps.push({ startTime: lastFrame, duration: gap });
      }
      lastFrame = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    window.addEventListener("error", (event) => {
      state.errors.push(event.message);
    });
    window.addEventListener("unhandledrejection", (event) => {
      state.errors.push(String(event.reason));
    });
  });
}

export async function resetDomainPerfMetrics(page: Page) {
  await page.evaluate(() => {
    const state = (window as WindowWithDomainPerf).__domainPerf;
    if (!state) return;
    state.startedAt = performance.now();
    state.longTasks = [];
    state.rafGaps = [];
    state.maxRafGap = 0;
    state.inputEvents = [];
    state.errors = [];
  });
}

export async function getDomainPerfMetrics(
  page: Page,
): Promise<DomainPerfMetrics> {
  return page.evaluate(() => {
    const state = (window as WindowWithDomainPerf).__domainPerf;
    if (!state) {
      throw new Error("Domain perf probe was not installed");
    }

    return {
      ...state,
      url: window.location.href,
      userAgent: navigator.userAgent,
      maxLongTaskDuration: Math.max(
        0,
        ...state.longTasks.map((entry) => entry.duration),
      ),
      totalLongTaskDuration: state.longTasks.reduce(
        (total, entry) => total + entry.duration,
        0,
      ),
      maxInputDuration: Math.max(
        0,
        ...state.inputEvents.map((entry) => entry.duration),
      ),
    };
  });
}

export async function attachDomainPerfMetrics(
  testInfo: TestInfo,
  metrics: DomainPerfMetrics,
) {
  await attachJsonArtifact(testInfo, "domain-filter-perf.json", metrics);
}

export async function attachJsonArtifact(
  testInfo: TestInfo,
  name: string,
  value: unknown,
) {
  const outputPath = testInfo.outputPath(name);
  await writeFile(outputPath, JSON.stringify(value, null, 2));
  await testInfo.attach(name, {
    path: outputPath,
    contentType: "application/json",
  });
}

export async function openDomainOverview(page: Page, tab: DomainTab) {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("domain-overview-e2e-cleared") === "1") {
      return;
    }
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith("domain-overview-filter-defaults:")) {
        window.localStorage.removeItem(key);
      }
    }
    window.sessionStorage.setItem("domain-overview-e2e-cleared", "1");
  });
  await page.goto("/");
  await page.waitForURL(/\/p\/([^/]+)\/?$/, {
    timeout: 30_000,
  });

  const match = page.url().match(/\/p\/([^/]+)/);
  if (!match) throw new Error(`Could not read project id from ${page.url()}`);

  const params = new URLSearchParams({
    domain: PRIMARY_TEST_DOMAIN,
    scope: "subdomains",
    sort: "traffic",
    order: "desc",
  });
  if (tab === "pages") params.set("tab", "pages");

  await page.goto(`/p/${match[1]}/domain?${params.toString()}`);
  await expect(
    page.getByRole("heading", { name: "Domain Overview" }),
  ).toBeVisible();
  // **After the navigation, and waiting.** The modal re-arms on every pathname
  // change, so this is the dismissal that actually matters; the one on `/` cleared
  // the route before it and is not evidence about this one.
  await dismissSetupModal(page, { wait: true });
  await expect(page.getByRole("button", { name: /Filters/ })).toBeVisible({
    timeout: 30_000,
  });
  await expectPageResponsive(page, "after opening Domain Overview");
}

/**
 * Clear the DataForSEO setup modal out of the way, and prove it is gone.
 *
 * ## Why the previous helper was a race, and what it cost
 *
 * It read `await dismissButton.isVisible()` — a **non-waiting** check — and clicked
 * only if that snapshot already saw the button. The modal is opened by an effect that
 * fires once `getSeoApiKeyStatus()` resolves, which is *after* the route has rendered,
 * so the check almost always ran before it existed: the click never happened, the
 * backdrop stayed, and every later `click()` failed with
 * *"…bg-black/50 p-4 intercepts pointer events"*. Four of the seven tests failed that
 * way, and the error names an unlabelled `<div>` from `AppShellParts.tsx` — which
 * points at the layout, not at the modal, so the reader is sent to the wrong file.
 *
 * ## Why one dismissal is not enough, and why waiting once is not either
 *
 * The modal's opener is a React Query call, so **there is more than one render that
 * can show it**: the effect runs once when the query first resolves, and again on any
 * refetch (React Query returns a fresh object identity each time, which is a new value
 * in the effect's dependency array). A helper that dismisses on the first sighting and
 * returns is therefore racy in the *other* direction — it proves a dismissal, not the
 * absence of the next one.
 *
 * So this waits for the modal to settle: dismiss, then confirm it stays hidden for a
 * quiet period that is long enough for a refetch to have happened. **`waitFor("hidden")`
 * alone is not enough** — it is satisfied the instant the dialog unmounts, which is
 * before the refetch that re-opens it has run. That is precisely the sequence that
 * produced the four remaining failures after the first fix.
 *
 * ## Why Dismiss rather than Escape
 *
 * Both close the dialog (`AppShell.tsx:105` binds Escape, and the button calls
 * `onClose`). The button is used here because it is the path a user takes and the one
 * whose click proves the backdrop is not swallowing pointer events — if the backdrop
 * *were* intercepting, the click would fail here rather than three assertions later.
 *
 * @param settleMs How long the modal must stay hidden. Defaults to the query's refetch
 *   window, so the check spans one refetch rather than hoping to beat it.
 */
async function dismissSetupModal(
  page: Page,
  options?: { wait?: boolean; settleMs?: number },
): Promise<boolean> {
  const dialog = page.getByRole("dialog", { name: /One quick setup step/i });
  const settleMs = options?.settleMs ?? 3_000;

  if (options?.wait) {
    // Wait for it to be *present or provably absent*, rather than guessing which.
    // The modal's opener is a query, so "absent" is a real state on a machine with a
    // key configured — and the previous helper's silent pass made that state
    // indistinguishable from a failure to dismiss.
    try {
      await dialog.waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      return false;
    }
  } else if (!(await dialog.isVisible())) {
    // Still wait a beat: the modal may be opening right now, and an early "absent"
    // is the same silent pass the previous helper made.
    await page.waitForTimeout(500);
    if (!(await dialog.isVisible())) return false;
  }

  // Scoped, because "Dismiss" is not unique on this page — `GoogleAnalyticsConnectionCard`
  // renders one too, and an unscoped click resolves to two elements and fails in
  // strict mode. The failure message from that names the other component's file,
  // which is a second way this helper can point a reader at the wrong artifact.
  const dismiss = dialog.getByRole("button", { name: "Dismiss" });
  await dismiss.click();

  await dialog.waitFor({ state: "hidden", timeout: 5_000 });

  // **The settle.** The dialog is gone; now prove it stays gone across a refetch
  // window. This is the assertion the previous version was missing entirely, and it
  // is what turns "I dismissed a modal" into "this page is usable".
  await page.waitForTimeout(settleMs);
  if (await dialog.isVisible()) {
    // A re-opened modal is a **product defect, not a test artifact**, and it is
    // reported as one: the layout re-opens the reminder on a refetch that should not
    // have re-opened it. Surfacing it as an error here keeps the suite honest about
    // which side of the boundary the bug is on.
    throw new Error(
      "The DataForSEO setup modal re-opened after being dismissed. That is a product defect in " +
        "AppShell.tsx: the reminder re-arms on a status refetch it should ignore. Fix the app, " +
        "not this helper.",
    );
  }

  return true;
}

export async function waitForDomainRows(page: Page, label: string) {
  const marker = label.includes("Pages")
    ? page.getByRole("link", { name: /\/section-a\/page-001/ }).first()
    : page
        .getByRole("row", {
          name: /primary sample query.*\/section-a\/page-001/,
        })
        .first();
  await expect(marker, label).toBeVisible({ timeout: 30_000 });
  await expectPageResponsive(page, `after table rows loaded for ${label}`);
}

export async function switchDomainTab(page: Page, tab: DomainTab) {
  const label = tab === "keywords" ? "Top Keywords" : "Top Pages";
  await page.getByRole("tab", { name: label }).click();
  await expect(page.getByRole("tab", { name: label })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expectPageResponsive(page, `after switching to ${label}`);
}

export async function openFilters(page: Page) {
  await page.getByRole("button", { name: /Filters/ }).click();
  await expect(page.getByText("Refine table results")).toBeVisible();
  await expectPageResponsive(page, "after opening filters");
}

export async function closeFilters(page: Page) {
  await page.getByRole("button", { name: /Filters/ }).click();
  await expect(page.getByText("Refine table results")).toBeHidden();
  await expectPageResponsive(page, "after closing filters");
}

export async function ensureFiltersOpen(page: Page, expectedLabel: string) {
  if (!(await page.getByText(expectedLabel).isVisible())) {
    await openFilters(page);
  }
  await expect(page.getByText(expectedLabel)).toBeVisible();
}

export async function applyFilters(
  page: Page,
  expectedParam = "minTraffic",
  expectedValue = "10",
) {
  await page.getByRole("button", { name: /Apply filters/ }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get(expectedParam))
    .toBe(expectedValue);
  await expect(page.getByRole("button", { name: /Filters/ })).toContainText(
    "1",
  );
  await expectPageResponsive(page, "after applying filters");
}

export async function typeIntoDraftInput(
  page: Page,
  input: Locator,
  value: string,
  label: string,
  options?: {
    actionTimeoutMs?: number;
    cdpSession?: CDPSession;
    inputLatencyBudgetMs?: number;
    recordPerf?: boolean;
  },
) {
  const actionTimeout = options?.actionTimeoutMs ?? 5_000;
  const budget = options?.inputLatencyBudgetMs ?? INPUT_LATENCY_BUDGET_MS;
  const started = Date.now();
  await input.click({ timeout: actionTimeout });
  if (options?.cdpSession) {
    await withTimeout(
      input.evaluate((element) => {
        if (!(element instanceof HTMLInputElement)) {
          throw new Error("Expected a text input");
        }
        element.value = "";
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }),
      actionTimeout,
      `Input clear did not settle for ${label}`,
    );
  } else {
    await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A", {
      timeout: actionTimeout,
    });
    await input.press("Backspace", { timeout: actionTimeout });
  }

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    const keyStarted = Date.now();
    if (options?.cdpSession) {
      await withTimeout(
        options.cdpSession.send("Input.dispatchKeyEvent", {
          type: "char",
          text: char,
        }),
        actionTimeout,
        `CDP input did not settle for ${label} char ${index + 1}`,
      );
    } else {
      await input.press(char, { timeout: actionTimeout });
    }
    const keyDuration = Date.now() - keyStarted;
    if (options?.recordPerf) {
      await recordInputLatency(page, `${label} char ${index + 1}`, keyDuration);
    }
    await expectPageResponsive(page, `after typing ${label}`);
  }

  const duration = Date.now() - started;
  if (options?.recordPerf) {
    await recordInputLatency(page, label, duration);
  }
  expect(duration, `${label} input latency`).toBeLessThan(budget);
}

export async function expectPageResponsive(page: Page, label: string) {
  await withTimeout(
    page.evaluate(() => document.body.textContent?.includes("Domain Overview")),
    RESPONSIVE_TIMEOUT_MS,
    `Page did not respond ${label}`,
  );
}

async function recordInputLatency(page: Page, label: string, duration: number) {
  await page.evaluate(
    ({ label: eventLabel, duration: eventDuration }) => {
      const state = (window as WindowWithDomainPerf).__domainPerf;
      state?.inputEvents.push({
        label: eventLabel,
        duration: eventDuration,
        time: performance.now(),
      });
    },
    { label, duration },
  );
}

async function withTimeout<T>(
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
