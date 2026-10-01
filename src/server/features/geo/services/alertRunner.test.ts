import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  alertOnRunChange,
  ALERT_TRANSPORT,
} from "@/server/features/geo/services/alertRunner";
import type { describeRunGap } from "@/server/features/geo/services/runObservations";
import {
  T1,
  T2,
  T8,
  answer,
  closeAlertFixture,
  installAlertFixture,
  resetAlertFixture,
  snapshot,
} from "./alertFixture";

/**
 * The decisions an alerting chain makes by **not** speaking, plus the gap it
 * reports alongside them.
 *
 * ## Why this file is smaller than it was
 *
 * The tests about *which run* an alert covers, and *whose answers* it compares,
 * moved to `alertBrandScoping.test.ts`. They are a coherent subject — "about what"
 * rather than "whether" — and keeping them here pushed this file past the
 * project's 400-line limit.
 *
 * The database harness moved with them into `alertFixture.ts`, shared by both
 * suites. **Two copies of a harness drift**: the second omits a migration, its
 * suite fails with `no such column`, and the error blames the schema rather than
 * the fixture — the exact confusion `scripts/migration-coverage.test.ts` exists to
 * prevent.
 *
 * What is left is what this file was originally written for, and it is still the
 * more valuable of the two: **what the chain does when it has nothing to say.**
 * An alerting chain is judged almost entirely on that. A system that alerts when
 * it has no baseline, or when the run archived nothing, will be muted within a
 * week — and then the real alert goes unread too.
 */

let describeGap: typeof describeRunGap;
let transport: typeof ALERT_TRANSPORT;
let runAlerts: typeof alertOnRunChange;

/**
 * **The fixture is installed before the module under test is imported**, and that
 * ordering is load-bearing rather than stylistic: both modules read `@/db` at
 * import time, so an import that ran first would capture a real unconfigured
 * client and every query would fail on `undefined.prepare`.
 */
beforeAll(async () => {
  await installAlertFixture();
  const mod = await import("@/server/features/geo/services/alertRunner");
  runAlerts = mod.alertOnRunChange;
  transport = mod.ALERT_TRANSPORT;
  describeGap = (await import("@/server/features/geo/services/runObservations"))
    .describeRunGap;
});

beforeEach(resetAlertFixture);
afterAll(closeAlertFixture);

describe("alertOnRunChange", () => {
  it("says nothing when the run archived nothing", async () => {
    // A budget cap, an outage, a project with no prompts: all real, none of them
    // a visibility change. Alerting here would tell a customer they lost
    // mentions that were never looked up.
    await snapshot("s1", T1);
    const sent: string[] = [];

    const result = await runAlerts({
      projectId: "p1",
      snapshotId: null,
      transport: async (m) => {
        sent.push(m.subject);
      },
    });

    expect(result.outcome).toBe("not_applicable");
    expect(sent).toEqual([]);
  });

  it("delivers a gained mention, which used to be classified and then dropped", async () => {
    // **The ninth instance of this codebase's favourite bug, and the one a
    // customer would have felt.** `decideAlerts` puts every `mention_gained` in
    // `suppressed` — deliberately, on the reasoning that a gain is not worth an
    // interruption. `buildDigest` formats them. **Nothing called `buildDigest`**, so
    // a brand that started being mentioned produced no message of any kind.
    //
    // The design rationale is sound and worth keeping: a channel carrying only
    // losses gets muted. What was missing was the delivery, and the two tests below
    // assert it end to end — through the runner, into a transport, not against the
    // formatter.
    //
    // The mention rule matches the **domain** in the body, and the fixture's
    // auto-created target is `<id>.example.com` — so the gain has to be written
    // with `t1.example.com` in it. `alertFixture.ts` documents this trap in a
    // paragraph of its own, having already cost two multi-brand tests an hour, and
    // this test walked straight into it.
    //
    // `targetId` is the second half of the same trap, and it is the half that
    // actually mattered here. `answer` defaults it to `null`, and an unattributed
    // observation is **skipped by the decision layer** — so no pair ever formed and
    // no gain was ever possible, whatever the text said. `snapshot` sets a target
    // on the run; the answers have to name the same one.
    //
    // `source: "llm_responses"` on both answers is the third: the default is
    // `mentions_search`, and a row from that source *is* a mention by definition,
    // so it can never read as `mentioned: false` and no gain is detectable.
    //
    // All three produced `expected [] to have a length of 1` while the product was
    // in fact correct. **A fixture that cannot represent the case makes the test
    // indistinguishable from a broken dispatcher.**
    await snapshot("s1", T1);
    await answer("a1", "s1", "best crm", "Nobody in particular.", {
      source: "llm_responses",
      targetId: "t1",
    });
    await snapshot("s2", T2);
    await answer("a2", "s2", "best crm", "t1.example.com is a leader.", {
      source: "llm_responses",
      targetId: "t1",
    });

    const sent: string[] = [];
    const result = await runAlerts({
      projectId: "p1",
      snapshotId: "s2",
      transport: async (m) => {
        sent.push(m.subject);
      },
    });

    // The gain is a *digest*, not an interruption, so there is no "mention lost"
    // and no alert body — but something must have been sent, because before this
    // fix nothing was and the whole chain was silent about good news.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/good change|what changed/i);
    // And it is the roll-up, not a loss.
    expect(sent[0]).not.toMatch(/lost/i);
    expect(result.outcome).toBe("dispatched");
  });

  it("delivers a second, different gain, and suppresses only a repeat", async () => {
    // **This is the test the previous one was not.** The old test was named
    // "sends one roll-up per week" but its two fixtures are in **different ISO
    // weeks** (2026-10-02 is a Friday, 2026-10-08 the following Thursday), so it
    // passed whether or not the week was in the fingerprint at all. It was not
    // testing the thing its name claimed.
    //
    // The bug it should have caught: the fingerprint was `digest:project:week`,
    // and the message carries only *this call's* gains — so after the first send
    // every later gain that week matched and was recorded as a duplicate and
    // **never delivered.** Three cases all lost: the second brand of a multi-brand
    // patrol, the second queued answer of the week, and any gain found after an
    // unrelated gain had already gone out.
    //
    // So both halves are asserted here, and they pull in opposite directions,
    // which is what makes the pair worth having: **a new gain is delivered, a
    // repeated gain is not.**
    // **Every run's rows are written before any alert is decided.** The first
    // version of this fixture inserted the gamma baseline into `s1` *after*
    // `s2` had already been alerted on, so gamma's "previous" answer did not
    // exist while `s3` was decided either, and there was no gain to report. The
    // test was wrong in a way that looked exactly like the product being wrong:
    // `expected [...] to have a length of 2 but got 1`.
    //
    // So: three runs written in full, then three decisions. `s1` is all
    // unmentioned. `s2` gains **alpha only**. `s3` keeps alpha and adds **beta**.
    //
    // The crucial detail is that **`s2` must not also gain beta**, or `s3` has
    // nothing new to report and the digest correctly stays silent. I got this
    // wrong twice: first by writing the beta baseline after `s2` was decided, then
    // by having `s2` gain both prompts — in both cases the test said "1 message"
    // and looked like a product bug. A gain is a *change against a previous run*,
    // and a prompt already gained last run is not gained again.
    await snapshot("s1", T1);
    for (const p of ["alpha", "beta"]) {
      await answer(`a-${p}`, "s1", p, "Nobody.", {
        source: "llm_responses",
        targetId: "t1",
      });
    }
    await snapshot("s2", T2);
    // **Beta must have a row in `s2` too, unmentioned.** Without it there is no
    // pair for beta at all, so `s3` has nothing to diff and the digest correctly
    // stays silent — which is what I saw and misread as a product bug. A gain is a
    // change between two *observations*; a prompt that appears for the first time
    // in the current run is not a change, it is a new prompt.
    await answer("b1", "s2", "alpha", "t1.example.com leads.", {
      source: "llm_responses",
      targetId: "t1",
    });
    await answer("b2", "s2", "beta", "Nobody.", {
      source: "llm_responses",
      targetId: "t1",
    });

    const sent: string[] = [];
    const collect = async (m: { subject: string }) => {
      sent.push(m.subject);
    };

    await runAlerts({ projectId: "p1", snapshotId: "s2", transport: collect });
    // One gain, one roll-up.
    expect(sent).toHaveLength(1);

    // **Same ISO week.** `T2` is Friday 2026-10-02 and `T8` is Thursday the
    // following week, so using `T8` here would let a week-scoped fingerprint pass
    // — which is exactly what the previous version of this test did, and why it
    // never caught the defect it was named for. `s3` is a Tuesday, three days
    // after `s2` and inside the same Monday-bounded week.
    const s3At = new Date("2026-10-06T00:00:00.000Z");
    await snapshot("s3", s3At);
    for (const p of ["alpha", "beta"]) {
      await answer(`c-${p}`, "s3", p, "t1.example.com leads.", {
        source: "llm_responses",
        targetId: "t1",
      });
    }
    await runAlerts({ projectId: "p1", snapshotId: "s3", transport: collect });

    // Exactly one more message: beta's new gain. With a week-scoped fingerprint
    // this stays at 1, and beta is never reported.
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/good change|what changed/i);

    // And a fourth run where beta is *not* mentioned but was before is a LOSS,
    // which is an interruption, not a digest — so the roll-up count must not move.
    await snapshot("s4", new Date("2026-10-15T00:00:00.000Z"));
    await answer("d1", "s4", "alpha", "t1.example.com leads.", {
      source: "llm_responses",
      targetId: "t1",
    });
    await answer("d2", "s4", "beta", "Nobody.", {
      source: "llm_responses",
      targetId: "t1",
    });
    await runAlerts({ projectId: "p1", snapshotId: "s4", transport: collect });
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatch(/lost/i);
  });

  it("says nothing on the first run, because that is a baseline and not news", async () => {
    // The first message a product sends should be about something that
    // happened, not about having started. "We are now monitoring you" is how a
    // channel gets skimmed.
    await snapshot("s1", T1);
    await answer("a1", "s1", "best crm", "Acme leads.");
    const sent: string[] = [];

    const result = await runAlerts({
      projectId: "p1",
      snapshotId: "s1",
      transport: async (m) => {
        sent.push(m.subject);
      },
    });

    expect(result.outcome).toBe("no_baseline");
    expect(sent).toEqual([]);
  });

  it("says nothing when two runs agree", async () => {
    await snapshot("s1", T1);
    await answer("a1", "s1", "best crm", "Acme leads.");
    await snapshot("s2", T2);
    await answer("a2", "s2", "best crm", "Acme leads.");
    const sent: string[] = [];

    const result = await runAlerts({
      projectId: "p1",
      snapshotId: "s2",
      transport: async (m) => {
        sent.push(m.subject);
      },
    });

    expect(sent).toEqual([]);
    expect(result.outcome).toBe("dispatched");
    if (result.outcome === "dispatched") {
      expect(result.result.outcome).toBe("nothing_to_send");
    }
  });

  it("does not read a vanished body as a lost mention", async () => {
    // A pending row has no body. A body appearing or vanishing between runs is
    // the observable change, and a *pending* row is excluded by the decision
    // layer rather than being read as "the model stopped mentioning us".
    await snapshot("s1", T1);
    await answer("a1", "s1", "best crm", "Acme leads.");
    await snapshot("s2", T2);
    await answer("a2", "s2", "best crm", null);
    const sent: string[] = [];

    const result = await runAlerts({
      projectId: "p1",
      snapshotId: "s2",
      transport: async (m) => {
        sent.push(m.subject);
      },
    });

    // Whatever it decides, the *transport* must not have been told to send a
    // body-versus-pending difference as a mention loss, which is what this
    // asserts: the change is reported only if the decision layer called it one.
    if (sent.length > 0) {
      expect(sent.join(" ")).not.toMatch(/mention lost/i);
    }
    expect(result.outcome).toBe("dispatched");
  });

  it("pairs runs by prompt, not by position", async () => {
    // The dangerous one. A prompt set changes between runs, and a positional
    // comparison pairs answer *n* with answer *n* — producing a "mention lost"
    // for a prompt that never changed. The reader keys on the prompt, so a
    // reordered second run is a *non*-event.
    await snapshot("s1", T1);
    await answer("a1", "s1", "alpha", "Acme.");
    await answer("a2", "s1", "beta", "Acme.");

    await snapshot("s2", T2);
    // Same answers, opposite order.
    await answer("b2", "s2", "beta", "Acme.");
    await answer("b1", "s2", "alpha", "Acme.");

    const sent: string[] = [];
    const result = await runAlerts({
      projectId: "p1",
      snapshotId: "s2",
      transport: async (m) => {
        sent.push(m.subject);
      },
    });

    expect(sent).toEqual([]);
    expect(result.outcome).toBe("dispatched");
  });

  it("records the gap between runs so a week-old diff is not read as news", async () => {
    await snapshot("s1", T1);
    await answer("a1", "s1", "best crm", "Acme leads.");
    await snapshot("s2", T8);
    await answer("a2", "s2", "best crm", "Acme leads.");

    const result = await runAlerts({
      projectId: "p1",
      snapshotId: "s2",
      transport: async () => {},
    });

    expect(result.outcome).toBe("dispatched");
    if (result.outcome === "dispatched") {
      expect(result.gap).toBe("since 7 days ago");
    }
  });
});

describe("describeRunGap", () => {
  it("says nothing under a day, because 'since yesterday' is noise", () => {
    expect(
      describeGap({
        current: { startedAt: "2026-10-02T06:00:00.000Z" },
        previous: { startedAt: "2026-10-02T00:00:00.000Z" },
      }),
    ).toBeNull();
  });

  it("names the gap once it is long enough to matter", () => {
    expect(
      describeGap({
        current: { startedAt: "2026-10-03T00:00:00.000Z" },
        previous: { startedAt: "2026-10-02T00:00:00.000Z" },
      }),
    ).toBe("since yesterday");
  });

  it("says so when a timestamp is unreadable, rather than implying adjacency", () => {
    expect(
      describeGap({
        current: { startedAt: "not-a-date" },
        previous: { startedAt: "2026-10-02T00:00:00.000Z" },
      }),
    ).toBe("the time between the two runs is not recorded");
  });

  it("has no gap to report when there is no earlier run", () => {
    expect(
      describeGap({
        current: { startedAt: "2026-10-02T00:00:00.000Z" },
        previous: null,
      }),
    ).toBeNull();
  });
});

describe("the default transport", () => {
  it("succeeds, because a self-hosted install has no channel yet", async () => {
    // The three alternatives are all worse: throwing would fail every patrol
    // (the alerting failure becomes a monitoring outage), swallowing would hide
    // it, and recording `failed` would retry forever for an audience that does
    // not exist. A no-op that succeeds keeps the run healthy and makes the gap
    // visible as "no deliveries".
    await expect(
      transport({ subject: "s", body: "b", changes: [] }),
    ).resolves.toBeUndefined();
  });
});
