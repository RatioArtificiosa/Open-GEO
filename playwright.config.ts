import { defineConfig } from "@playwright/test";

/**
 * The e2e config, and the one defect that stopped the suite running at all.
 *
 * ## The defect: a POSIX env prefix on Windows `cmd`
 *
 * The command used to read
 * `NODE_OPTIONS= AUTH_MODE=local_noauth … pnpm exec vite dev --host …`. **`NAME=value`
 * prefixes are POSIX shell syntax and this repository runs on Windows `cmd`**, which
 * answers
 *
 * ```
 * 'NODE_OPTIONS' is not recognized as an internal or external command,
 * operable program or batch file.
 * ```
 *
 * and exits 1 before vite ever starts. So the whole suite was unrunnable, and the
 * failure looked like a missing binary — the reader's first move would have been to
 * reinstall a browser. **Playwright's `env` option is cross-platform and applies the
 * variables to the server process on any platform**, which is what this config now
 * uses: one file that runs on the developer's machine and in CI without a
 * shell-detecting wrapper.
 *
 * ## Why `vite dev` is the correct server here, and why `vite preview` is not
 *
 * This is a **TanStack Start SSR app** served by a Cloudflare worker: `dist/` holds
 * `client/`, `server/` and an aux worker, and **no `index.html` at any level** — a
 * route is rendered by the worker, not read from disk. `vite preview` serves static
 * files from `dist/`, so it has nothing to serve and the suite times out on the
 * first navigation. `vite dev` runs the same worker through the cloudflare vite
 * plugin, so the app under test is the real application rather than a subset of it.
 *
 * An earlier draft of this file changed the server to `vite build && vite preview` on
 * the reasoning that an e2e should measure what ships. That reasoning is right in
 * general and wrong for this app's shape — see the note on `build:app` below — and it
 * turned a working suite into seven failures, which is the more useful lesson: **a
 * config change made on principle, without running it, is a guess.**
 *
 * ## Why `executablePath` + `--no-sandbox`, not `channel: "chrome"`
 *
 * `channel` asks Playwright to find a stable-channel install **through its own
 * registry**, and Playwright's browser download is blocked on this machine — so the
 * registry is empty and the only Chrome is the real one at
 * `C:/Program Files/Google/Chrome/Application/chrome.exe`. `executablePath` names that
 * binary directly: **the path is a fact, `channel` is a search.** It is the same
 * reason a fixture path is written as a literal rather than resolved at runtime.
 *
 * `--no-sandbox` travels with it because a Chrome launched by a test process in a
 * CI-like tree refuses the sandbox it would normally take for granted. Without the
 * flag the browser exits or hangs on the first navigation, and **the failure reads as
 * "the app did not start"** — which sends the reader to the wrong artifact entirely.
 *
 * ## Why `networkidle`
 *
 * `domcontentloaded` fires when the HTML parses, **before the webfont lands**. A
 * measurement taken then measures the fallback face: Instrument Sans's `0` advance is
 * narrow, so `68ch` resolves to 78 characters and a line-count assertion passes
 * against a layout nobody would ever see. `networkidle` waits for the network to go
 * quiet, the earliest moment a *rendered* measurement is honest.
 *
 * ## On `build:app`, which the goal file names and the tree does not have
 *
 * The goal's prescription said "build with `npm run build:app` (output
 * `dist/client`)". **`build:app` is not a script in `package.json`** — the real build
 * is `npm run build` → `vite build && tsc --noEmit` — and `dist/client` is a
 * *subdirectory* of the output holding the static assets, while `dist/server/` holds
 * the worker. The prescription was written against a different app shape. It is
 * recorded here rather than silently followed, because **a goal file is a claim about
 * the tree, and a claim that does not match the tree is corrected in place.**
 */

/** Chrome as installed on this machine. Overridable for a machine without it. */
const CHROME_PATH =
  process.env.PLAYWRIGHT_CHROME_PATH ??
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3101",
    actionTimeout: 5_000,
    navigationTimeout: 30_000,
    launchOptions: {
      executablePath: CHROME_PATH,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    /**
     * `vite dev`, with the environment in `env` rather than in the command. See the
     * header for why the server is the dev server and not a preview of the build.
     */
    command: "pnpm exec vite dev --host 127.0.0.1 --strictPort",
    url: "http://localhost:3101",
    reuseExistingServer: false,
    timeout: 180_000,
    /**
     * The four variables, cross-platform.
     *
     * - `PORT=3101` — matches `baseURL`. `--strictPort` makes a collision a loud
     *   failure instead of silently serving on 3102, where every navigation would
     *   miss.
     * - `AUTH_MODE=local_noauth` — the suite has no session to authenticate with,
     *   and without it the built app demands Cloudflare Access (`TEAM_DOMAIN` +
     *   `POLICY_AUD`) and shows an "Authentication setup required" page instead of
     *   the app. **That page is what the seven failures were:** not a broken
     *   config so much as a variable that never reached the worker.
     * - The two fixture flags make the run deterministic **and free** — no vendor
     *   call — so a suite that must be green on a laptop with no API key can be.
     *
     * `AUTH_MODE` is on the `envPrefix` list in `vite.config.ts`, which is what lets
     * the worker read it from the environment; the values here are the ones the
     * original command string intended and could not deliver.
     */
    env: {
      PORT: "3101",
      AUTH_MODE: "local_noauth",
      VITE_E2E_DOMAIN_FIXTURES: "1",
      VITE_E2E_KEYWORD_FIXTURES: "1",
    },
  },
});
