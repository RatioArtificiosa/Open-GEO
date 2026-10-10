/**
 * The default `cloudflare:workers` mock, driven by an environment variable.
 *
 * ## Why this file exists
 *
 * The repository's invariant is that schema, queries and mutations work on **both**
 * SQLite and Postgres. `schema-parity.test.ts` is the gate for that claim, and it
 * compares in-process objects, which is the strongest check available cheaply.
 *
 * What nothing could do was **run the rest of the suite on the Postgres path**.
 * 103 test files stub `cloudflare:workers`, all with `DATABASE_PROVIDER: "d1"`,
 * and zero with `"postgres"`. So `db/index.ts`, `db/provider.ts` and every
 * repository were only ever *imported* on SQLite. Commit `2a785c9`'s message
 * names the resulting failure exactly — *"the postgres barrel pointed at the
 * sqlite table, so its migration was never generated"* — and CI stayed green,
 * because only a human read generator output.
 *
 * A green CI run on one dialect is not evidence about the other. This file makes
 * the provider a **variable** rather than a constant baked into every stub:
 * `DATABASE_PROVIDER=postgres vitest run` now executes the whole suite against
 * the Postgres barrel, and CI runs both.
 *
 * ## Why a setup file and not editing 103 stubs
 *
 * A baseline registered in `setupFiles` runs before any test module loads, so
 * tests that pin a provider explicitly still win, and everything that does not
 * care inherits the environment. Editing 103 files to read an env var would be
 * the same behaviour with 103 chances to typo, and would leave every existing
 * stub a decision someone has to make again.
 *
 * ## What it deliberately does not do
 *
 * It does not stand up a Postgres **server**. The pg barrel resolves its
 * connection through `getPostgresConnectionString()` → the `HYPERDRIVE` binding,
 * which needs a live endpoint. What this buys is the half that was actually
 * broken and was never exercised: module resolution, barrel wiring, the
 * `getDatabaseProvider()` branch, and every schema-parity comparison, on the
 * Postgres path. A repository needs a driver; a barrel does not.
 */

import { vi } from "vitest";

const provider = process.env.DATABASE_PROVIDER ?? "d1";

if (provider !== "d1" && provider !== "postgres") {
  // Fail loudly, the way `getDatabaseProvider` does, rather than silently
  // falling back to SQLite and reporting a green run that tested nothing.
  throw new Error(
    `Unsupported DATABASE_PROVIDER "${provider}". Expected "d1" or "postgres".`,
  );
}

vi.mock("cloudflare:workers", () => ({
  env: {
    DATABASE_PROVIDER: provider,
  },
}));
