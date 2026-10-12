/**
 * Test-budget floors for work that spawns a subprocess or builds a schema.
 *
 * ## Why this file exists
 *
 * Vitest's defaults — 5 seconds for a test, 10 for a hook — are sized for
 * in-process work. Three things in this repository are not in-process:
 *
 *   1. **A gate run through `spawnSync`.** `cost-profile.mjs` takes ~600ms when
 *      the machine is idle, but spawning a node process from inside a worker is
 *      bounded by the machine, not by the script. Under a full-suite load with
 *      eight workers it exceeded 5s and failed with a timeout — a failure that
 *      says nothing about the gate and everything about the load.
 *   2. **A `beforeAll` that builds an in-memory schema.** The rotation tests create
 *      a libsql client and apply a migration chain. Same failure, same cause.
 *
 * Both already appeared in this repository once: `src/serverFunctions/geo.test.ts`
 * timed out for the module-graph import, and the fix there was to move the work to
 * `beforeAll` with an explicit timeout. **This file is the same decision, applied
 * to the cases a per-file fix would not reach.**
 *
 * ## What these numbers are chosen for
 *
 * Generous enough that a slow machine passes, small enough that a genuine hang
 * still fails. The rotation hooks build a schema in well under a second when
 * idle; 60 seconds is an order of magnitude over that and still far below a CI
 * job's own limit. The cost-profile test spawns a 0.6s script; 60s is the same
 * trade.
 *
 * ## What this does not cover, and is not meant to
 *
 * A test that times out because it is genuinely slow — a real N+1, an unbounded
 * loop — will time out at 60s too, just later. The budget is not a fix for a
 * performance regression; it is the distinction between "the machine was busy"
 * and "this test is slow", which the default could not make because it could not
 * tell them apart either.
 */
export const SUBPROCESS_TEST_TIMEOUT_MS = 60_000;
