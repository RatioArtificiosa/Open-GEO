import { defineConfig } from "vitest/config";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsConfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    /**
     * The baseline `cloudflare:workers` mock, read from `DATABASE_PROVIDER`.
     *
     * Without this the whole suite is hard-wired to SQLite: every stub supplies
     * `"d1"`, so the Postgres barrel, the `getDatabaseProvider()` branch and
     * every schema-parity comparison on that path are never executed. CI is
     * therefore green without being evidence about the second dialect, which is
     * the exact hole commit `2a785c9` fell into.
     *
     * A setup file is the right level: tests that pin a provider still win, and
     * everything that does not care inherits the environment. See
     * `vitest.setup.ts` for why that beats editing 103 stubs.
     */
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
    clearMocks: true,
    server: {
      deps: {
        // Processed by vitest (instead of loaded natively by node) so the
        // oauth-refresh e2e test's cloudflare:workers mock reaches the real
        // provider module.
        inline: ["@cloudflare/workers-oauth-provider"],
      },
    },
  },
});
