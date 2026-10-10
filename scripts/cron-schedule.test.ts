import { describe, expect, it } from "vitest";
import { join } from "node:path";

/**
 * The cron schedule itself.
 *
 * There is one thing this file exists to prevent, and it is the most expensive
 * bug shape in this repo: **a nightly job wired onto a five-minute tick.**
 *
 * ## What was wrong
 *
 * `src/server.ts` gated the daily OAuth GC behind
 * `if (controller.cron === DAILY) { ...; return; }`. The `return` meant the
 * daily tick did *only* the GC — so on `17 3 * * *` the stale-audit watchdog,
 * the GEO patrol, GEO retention and the rank checks all silently did **not**
 * run, while every other tick ran all of them. The comments said "the nightly
 * patrol rides the same daily tick"; the code did the exact inverse.
 *
 * Nothing caught it, and the reason is the part worth remembering: the patrol's
 * own 24-hour cadence filter made a 5-minute tick a no-op *for the patrol*, so
 * the inversion was invisible in the data and would only have become a billing
 * incident the moment someone removed that filter or changed the cadence. **A
 * latent billing bug that no test can see is still a latent billing bug**, and the
 * fix is to pin the *schedule*, not the behaviour that happened to mask it.
 *
 * So these are assertions about the crons and the dispatch order, read from the
 * source, with no database and no Worker. If someone reintroduces a `return`
 * inside the daily branch, the third test fails.
 */

// Resolved from the repo root rather than the process cwd: vitest runs from
// different roots for different invocations, and a relative path that works in
// `pnpm vitest` fails in a bare `npx vitest`. The first version of this file
// read `server.ts` fine and the patrol file not at all, for exactly that reason.
const REPO_ROOT = process.cwd().endsWith("scripts")
  ? process.cwd().replace(/scripts[\\/]?$/, "")
  : process.cwd();

const SCHEDULE_SOURCE = join(REPO_ROOT, "src/server.ts");
const WORKFLOWS_SOURCE = join(REPO_ROOT, "wrangler.jsonc");
const PATROL_SOURCE = join(
  REPO_ROOT,
  "src/server/features/geo/services/scheduledGeoPatrol.ts",
);

async function read(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

describe("the cron schedule", () => {
  it("registers a fast tick and a daily tick", async () => {
    const wrangler = await read(WORKFLOWS_SOURCE);
    // Plain substrings, not a regex: `*/5 * * * *` is five `*`s and an escaped
    // one is a readability trap in a file whose whole job is to be obvious.
    // Both must exist, or one of the two dispatch paths is dead code.
    expect(wrangler).toContain('"*/5 * * * *"');
    expect(wrangler).toContain('"17 3 * * *"');
  });

  it("runs the daily OAuth GC only on the daily tick", async () => {
    const source = await read(SCHEDULE_SOURCE);
    // The GC is gated on the daily cron expression…
    expect(source).toMatch(/controller\.cron === MCP_OAUTH_PURGE_CRON/);
    // …and the daily tick is *additive*: the shared work below it must not be
    // inside an early return.
    const dailyIndex = source.indexOf("const isDailyTick =");
    expect(dailyIndex).toBeGreaterThan(-1);
    const after = source.slice(dailyIndex);
    // A `return` between the daily branch and the shared work is the exact shape
    // of the bug. The shared work must appear before any return at all.
    const sharedIndex = after.indexOf("reconcileStaleAudits");
    expect(sharedIndex).toBeGreaterThan(-1);
    expect(after.slice(0, sharedIndex)).not.toMatch(/^\s*return;/m);
  });

  it("dispatches the shared nightly work on every tick, in order", async () => {
    const source = await read(SCHEDULE_SOURCE);
    // The three that must share the tick, in the order the comments promise:
    // reconcile (watchdog) → collect (patrol) → age out (retention).
    const watchdog = source.indexOf("reconcileStaleAudits()");
    const patrol = source.indexOf("runDueGeoPatrols()");
    const retention = source.indexOf("runScheduledGeoRetention(env)");
    expect(watchdog).toBeGreaterThan(-1);
    expect(patrol).toBeGreaterThan(-1);
    expect(retention).toBeGreaterThan(-1);
    expect(watchdog).toBeLessThan(patrol);
    expect(patrol).toBeLessThan(retention);
  });

  it("still runs rank checks on the daily tick", async () => {
    // The one the inversion broke hardest: rank tracking is a customer-visible
    // promise about data freshness, and it stopped updating once a day.
    const source = await read(SCHEDULE_SOURCE);
    const rankIndex = source.indexOf("runScheduledRankChecks(env)");
    expect(rankIndex).toBeGreaterThan(-1);
    const dailyIndex = source.indexOf("const isDailyTick =");
    expect(rankIndex).toBeGreaterThan(dailyIndex);
  });

  it("keeps the patrol's own 24-hour cadence filter", async () => {
    // The filter that has been masking the inversion. It is the reason the bug
    // was invisible, and it is *not* the fix — the fix is the dispatch above.
    // Removing it without fixing the schedule would bill 288 patrols a day.
    const source = await read(PATROL_SOURCE);
    // `24 * 60 * 60 * 1000` — four factors. The first draft of this assertion
    // wrote three, which failed against a file that was correct; the mismatch was
    // in the test, and reading the actual codepoints was the only way to see it.
    expect(source).toMatch(/24 \* 60 \* 60 \* 1000/);
    // And the comment explaining why it exists must stay, or a future reader will
    // "clean up" the filter and unknowingly trigger the billing bug.
    expect(source).toMatch(/billed|re-billed/i);
  });

  // ── The billable nightly captures ──────────────────────────────────────────
  //
  // These four assertions are the second instance of the exact bug the file
  // header describes, and they exist because the first instance was caught by a
  // *reader* rather than by a gate.
  //
  // The three nightly captures that bill the vendor were dispatched on every
  // tick. Each one's own code said that was safe — the AI Mode runner carried an
  // `alreadyRanInWindow` hook the cron caller never passed, and the AI-keyword
  // and ETV runners had no run log at all, only a `lastAskedAt` rotation that
  // reorders who is measured and never decides whether to measure. So they ran
  // 288 times a night on a `*/5` schedule: at their own caps, ETV alone is
  // ~$2,590/month instead of ~$9.
  //
  // The reason no gate saw it is the reason these assertions are written the way
  // they are: **every number the sweeps report is internal to the sweep.**
  // `projectsVisited` counted rows the sweep had just chosen, so the log line
  // read identically after the first tick and the two-hundred-and-eighty-eighth.
  // A budget checked per tick bounds a tick, not a night. The only thing that
  // can catch it is an assertion about the dispatch itself.

  it("gates the three billable captures on the nightly tick", async () => {
    const source = await read(SCHEDULE_SOURCE);
    // The captures are dispatched through one call, not three inline blocks,
    // so a fourth billable capture has an obvious place to go and one gate to
    // inherit rather than a fresh chance to forget.
    expect(source).toContain("runNightlyBillableCaptures");
    // …and that call is inside the nightly gate, not merely present in the file.
    const gateIndex = source.indexOf("const isNightlyTick =");
    expect(gateIndex).toBeGreaterThan(-1);
    const afterGate = source.slice(gateIndex);
    const callIndex = afterGate.indexOf("runNightlyBillableCaptures()");
    expect(callIndex).toBeGreaterThan(-1);
    // No early `return` between the flag and the dispatch — the same shape as
    // the original inversion, and just as invisible.
    expect(afterGate.slice(0, callIndex)).not.toMatch(/^\s*return;/m);
    expect(afterGate.slice(0, callIndex)).toMatch(/isNightlyTick\)\s*\{/);
  });

  it("does not dispatch a billable capture outside the nightly gate", async () => {
    // The negative assertion the first version of this gate lacked: the three
    // runners must not appear as bare calls anywhere in the handler, or the
    // gate above is decoration around a second copy.
    const source = await read(SCHEDULE_SOURCE);
    for (const runner of [
      "runDueAiModeCaptures(",
      "runDueAiKeywordCaptures(",
      "runDueEtvCaptures(",
    ]) {
      expect(source).not.toContain(`withPgClient(() => ${runner})`);
      expect(source).not.toContain(`withPgClient(() => ${runner}`);
    }
    // They must also not be imported into the handler at all: an import that
    // nothing calls is the first half of a second dispatch path.
    expect(source).not.toMatch(/^import .*runDueAiModeCaptures/m);
  });

  it("keeps the nightly gate on the same cron expression as the daily work", async () => {
    // One expression, two names, one reason: `isDailyTick` gates the free daily
    // work and `isNightlyTick` gates the billable work, and they must be the
    // same `17 3 * * *` or one of them silently reverts to a five-minute tick.
    const source = await read(SCHEDULE_SOURCE);
    expect(source).toMatch(
      /const isDailyTick = controller\.cron === MCP_OAUTH_PURGE_CRON/,
    );
    expect(source).toMatch(/const isNightlyTick = isDailyTick;/);
    // And the constant itself must still be the daily expression.
    expect(source).toContain('"17 3 * * *"');
  });

  it("still runs the free daily work on the nightly tick", async () => {
    // The gate must not have become another `return`. The patrol, the drain,
    // retention and rank checks all still run at 03:17 alongside the captures.
    const source = await read(SCHEDULE_SOURCE);
    const nightlyGate = source.indexOf("if (isNightlyTick)");
    expect(nightlyGate).toBeGreaterThan(-1);
    for (const shared of [
      "reconcileStaleAudits()",
      "runDueGeoPatrols()",
      "runQueueDrain()",
      "runScheduledGeoRetention(env)",
      "runScheduledRankChecks(env)",
    ]) {
      expect(source.indexOf(shared)).toBeGreaterThan(-1);
    }
  });
});
