import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    turnstileTest: {
      callbacks: Record<string, (token?: string) => void>;
      expired: boolean;
      resets: number;
      removed: number;
      rendered: number;
    };
  }
}

const scriptUrl = "**/turnstile/v0/api.js*";
const script = `
  const state = window.turnstileTest = {
    callbacks: {}, expired: false, resets: 0, removed: 0, rendered: 0
  };
  window.turnstile = {
    render(container, options) { state.callbacks = options; return String(++state.rendered); },
    reset() { state.resets++; state.expired = false; },
    remove() { state.removed++; },
    isExpired() { return state.expired; }
  };
`;
let requests: { path: string; token: string }[];
test.beforeEach(async ({ page }) => {
  requests = [];
  await page.route(scriptUrl, (route) =>
    route.fulfill({ contentType: "text/javascript", body: script }),
  );
  // Never call the paid provider endpoints from these browser tests.
  await page.route("**/api/**", (route) => {
    requests.push({
      path: new URL(route.request().url()).pathname,
      token: route.request().postDataJSON()?.turnstileToken,
    });
    return route.fulfill({ status: 503, json: { error: "Test response" } });
  });
});

async function openTool(
  page: Page,
  path = "backlink-checker",
  id = "backlink-target",
) {
  await page.goto(`/${path}`);
  await page.waitForFunction(() => window.turnstileTest?.rendered === 1);
  await page.locator(`#${id}`).fill("example.com");
  return page.locator("form").filter({ has: page.locator(`#${id}`) });
}
const solve = (page: Page, token = "verified-token") =>
  page.evaluate(
    (value) => window.turnstileTest.callbacks.callback(value),
    token,
  );

const tools = [
  ["backlink-checker", "backlink-target", "backlink-check"],
  ["spam-score-checker", "spam-target", "spam-score-checker"],
  ["website-traffic-checker", "traffic-target", "website-traffic-checker"],
  ["competitor-analysis", "competitor-domain", "competitor-analysis"],
  ["domain-age-checker", "age-domains", "domain-age-checker"],
  ["keyword-generator", "keyword-generator-input", "keyword-generator"],
  [
    "competitor-keyword-finder",
    "competitor-keyword-finder-input",
    "competitor-keyword-finder",
  ],
];
for (const [path, id, endpoint] of tools) {
  test(`${path} waits for verification and consumes each token once`, async ({
    page,
  }) => {
    const form = await openTool(page, path, id);
    const button = form.locator('button[type="submit"]');
    await expect(button).toBeDisabled();
    await form.dispatchEvent("submit");
    // Exceed the old three-second fallback: a slow solve must never send a request.
    await page.waitForTimeout(3_100);
    expect(requests).toEqual([]);
    expect(await page.evaluate(() => window.turnstileTest.resets)).toBe(0);

    await solve(page);
    await expect(button).toBeEnabled();
    await form.evaluate((element) => {
      element.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      element.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await expect(
      form.getByText("Test response", { exact: true }),
    ).toBeVisible();
    expect(requests).toEqual([
      { path: `/api/${endpoint}`, token: "verified-token" },
    ]);
    await expect(button).toBeDisabled();
    await form.dispatchEvent("submit");
    expect(requests).toHaveLength(1);

    await solve(page, "fresh-token");
    await button.click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].token).toBe("fresh-token");
  });
}

for (const callback of [
  "expired-callback",
  "error-callback",
  "timeout-callback",
  "unsupported-callback",
]) {
  test(`${callback} invalidates the token`, async ({ page }) => {
    const form = await openTool(page);
    await solve(page);
    await page.evaluate(
      (name) => window.turnstileTest.callbacks[name](),
      callback,
    );
    await form.dispatchEvent("submit");
    await expect(form.locator('button[type="submit"]')).toBeDisabled();
    expect(requests).toEqual([]);
    if (callback !== "expired-callback") {
      await form.getByRole("button", { name: "Retry verification" }).click();
      expect(await page.evaluate(() => window.turnstileTest.resets)).toBe(1);
    }
    await solve(page);
    await expect(form.locator('button[type="submit"]')).toBeEnabled();
  });
}

test("checks expiry again at submission", async ({ page }) => {
  const form = await openTool(page);
  await solve(page);
  await page.evaluate(() => {
    window.turnstileTest.expired = true;
  });
  await form.dispatchEvent("submit");
  expect(requests).toEqual([]);
  await expect(form.locator('button[type="submit"]')).toBeDisabled();
  expect(await page.evaluate(() => window.turnstileTest.resets)).toBe(1);
});

test("retries a failed script load", async ({ page }) => {
  await page.route(scriptUrl, (route) => route.abort(), { times: 1 });
  await page.goto("/backlink-checker");
  await page.getByRole("button", { name: "Retry verification" }).click();
  await page.waitForFunction(() => window.turnstileTest?.rendered === 1);
  await solve(page);
  await expect(
    page.getByRole("button", { name: "Check backlinks", exact: true }),
  ).toBeEnabled();
  expect(requests).toEqual([]);
});

test("removes the old widget and reuses the script on client navigation", async ({
  page,
}) => {
  await openTool(page);
  await solve(page);
  const oldCallback = await page.evaluateHandle(
    () => window.turnstileTest.callbacks.callback,
  );
  await page.getByRole("link", { name: "All free tools", exact: true }).click();
  await page.waitForFunction(() => window.turnstileTest.removed === 1);
  await page.goBack();
  await page.waitForFunction(() => window.turnstileTest.rendered === 2);
  expect(await page.evaluate(() => window.turnstileTest.removed)).toBe(1);
  await oldCallback.evaluate((callback) => callback("stale-token"));
  await expect(
    page.locator('form:has(#backlink-target) button[type="submit"]'),
  ).toBeDisabled();
  await solve(page);
  await expect(
    page.getByRole("button", { name: "Check backlinks", exact: true }),
  ).toBeEnabled();
});
