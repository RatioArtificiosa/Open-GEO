import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { alertOnRunChange } from "@/server/features/geo/services/alertRunner";
import {
  T1,
  T2,
  T8,
  answer,
  citation,
  closeAlertFixture,
  installAlertFixture,
  resetAlertFixture,
  snapshot,
  snapshotWithStatus,
  target,
  unattributedSnapshot,
} from "./alertFixture";

/**
 * Which run an alert is decided about, and whose answers it compares.
 *
 * Split out of `alertRunner.test.ts` because that file had grown past the
 * project's 400-line limit, and these tests are a coherent subject of their own:
 * the others ask *whether* an alert fires, these ask *about what*.
 *
 * ## Why this subject needed its own file
 *
 * Every test here is a regression for a bug where the alerting chain was
 * **confidently reporting the wrong thing** — and in every case the suite stayed
 * green, because the failure mode was a comparison against the wrong row rather
 * than an exception:
 *
 * - the domain was hardcoded to `null`, so `decideAlerts` skipped every mention
 *   change and only citation alerts could ever fire;
 * - the comparison key omitted the brand, so two brands sharing a prompt were
 *   diffed against each other;
 * - the run was re-derived as "newest in the project" rather than taken from the
 *   caller, and the docstring claimed "completed runs" while nothing filtered on
 *   status, so a failed run could become the baseline for every later comparison;
 * - the baseline was picked from an in-memory array, so the obvious `LIMIT 2`
 *   bound silently compared against the newest run instead of the previous one.
 */

let runAlerts: typeof alertOnRunChange;

/**
 * `alertRunner` reads `@/db` at import time, so it can only be imported once the
 * fixture has installed its `vi.doMock`. A dynamic import here is load-bearing,
 * not stylistic: a static one would capture a real unconfigured client and fail
 * every query on `undefined.prepare`.
 */
beforeAll(async () => {
  // Installed *before* the import below. Both modules read `@/db` at import time,
  // so importing first would capture a real unconfigured client and every query
  // would fail on `undefined.prepare`.
  await installAlertFixture();
  runAlerts = (await import("@/server/features/geo/services/alertRunner"))
    .alertOnRunChange;
});

beforeEach(resetAlertFixture);
afterAll(closeAlertFixture);

/** Collects whatever the transport is asked to send. */
function collector(): {
  sent: string[];
  transport: (m: { subject: string; body: string }) => Promise<void>;
} {
  const sent: string[] = [];
  return {
    sent,
    transport: async (m) => {
      sent.push(`${m.subject}\n${m.body}`);
    },
  };
}

describe("alertOnRunChange — which run, and whose answers", () => {
  it("alerts when the brand stopped being mentioned, and names it", async () => {
    // **The alert this whole chain exists to send, and which could not be sent.**
    //
    // The reader hardcoded `domain: null` and `decideAlerts` refuses any
    // comparison whose domain is null, so every mention change was silently
    // discarded. Nothing failed: the alert was recorded as suppressed, the suite
    // was green, and the product quietly never told a customer they lost a
    // mention.
    await target("t1", "acme.com");
    // Live hit, no body: the vendor only returns rows that named the brand, so
    // this is a mention on the evidence of the row's existence.
    await snapshot("s1", T1);
    await answer("a1", "s1", "best crm", null, { targetId: "t1" });

    // The *same* prompt, same platform, but this run the answer came back from
    // the queued endpoint and does not name the brand. Both sides name the same
    // prompt, which is what a diff requires, and the verdict flips.
    await snapshot("s2", T2);
    await answer(
      "a2",
      "s2",
      "best crm",
      "Salesforce and HubSpot are the usual choices.",
      { source: "llm_responses", targetId: "t1" },
    );

    const { sent, transport } = collector();
    await runAlerts({ projectId: "p1", snapshotId: "s2", transport });

    // The brand is named because the alert has to say *which* brand regressed,
    // and it can only do that because the domain is no longer null.
    expect(sent.join("\n")).toContain("acme.com");
  });

  it("alerts on each brand that changed, and only on those", async () => {
    // **The gap CL-501e closes, end to end.** One patrol of a two-brand project
    // writes two snapshots. Both brands lost a mention in the same run, and both
    // must be reported — the caller passes `snapshotIds` and gets one alert each.
    //
    // Before, `GeoPatrol` returned only the first snapshot id, so the second
    // brand's change was never decided at all: a real regression, reported to no
    // one. A single "was an alert sent" assertion would pass with one brand
    // silently dropped, so both brand names are asserted.
    await target("t_acme", "acme.com");
    await target("t_globex", "globex.com");

    // Both brands mentioned in the first run.
    await snapshot("s1_acme", T1, "t_acme");
    await answer("a1", "s1_acme", "best crm", "acme.com leads.", {
      source: "llm_responses",
      targetId: "t_acme",
    });
    await snapshot("s1_globex", T1, "t_globex");
    await answer("g1", "s1_globex", "best crm", "globex.com leads.", {
      source: "llm_responses",
      targetId: "t_globex",
    });

    // Second run: neither mentions its brand.
    await snapshot("s2_acme", T2, "t_acme");
    await answer("a2", "s2_acme", "best crm", "Nobody at all.", {
      source: "llm_responses",
      targetId: "t_acme",
    });
    await snapshot("s2_globex", T2, "t_globex");
    await answer("g2", "s2_globex", "best crm", "Nobody at all.", {
      source: "llm_responses",
      targetId: "t_globex",
    });

    const sent: string[] = [];
    const result = await runAlerts({
      projectId: "p1",
      snapshotId: "s2_acme",
      snapshotIds: ["s2_acme", "s2_globex"],
      transport: async (m) => {
        sent.push(`${m.subject}\n${m.body}`);
      },
    });

    const message = sent.join("\n");
    expect(message).toContain("acme.com");
    expect(message).toContain("globex.com");
    // Two distinct alerts, not one that mentions both: a single message would
    // read as one brand losing two mentions.
    expect(sent).toHaveLength(2);
    expect(result.outcome).toBe("dispatched");
    // And the caller can see that both brands alerted.
    expect(
      result.outcome === "dispatched" ? result.perBrand : null,
    ).toHaveLength(2);
  });

  it("says nothing for a brand that did not change, while another did", async () => {
    // The negative control for the test above, and the one that matters most for a
    // customer: a run where only globex changed must produce **one** alert, about
    // globex. Acme was mentioned in both runs and saying so would be a false alarm
    // on a brand that never moved.
    await target("t_acme", "acme.com");
    await target("t_globex", "globex.com");

    await snapshot("s1_acme", T1, "t_acme");
    await answer("a1", "s1_acme", "best crm", "acme.com leads.", {
      source: "llm_responses",
      targetId: "t_acme",
    });
    await snapshot("s1_globex", T1, "t_globex");
    await answer("g1", "s1_globex", "best crm", "globex.com leads.", {
      source: "llm_responses",
      targetId: "t_globex",
    });

    // Acme holds; globex falls.
    await snapshot("s2_acme", T2, "t_acme");
    await answer("a2", "s2_acme", "best crm", "acme.com still leads.", {
      source: "llm_responses",
      targetId: "t_acme",
    });
    await snapshot("s2_globex", T2, "t_globex");
    await answer("g2", "s2_globex", "best crm", "Nobody at all.", {
      source: "llm_responses",
      targetId: "t_globex",
    });

    const sent: string[] = [];
    await runAlerts({
      projectId: "p1",
      snapshotId: "s2_acme",
      snapshotIds: ["s2_acme", "s2_globex"],
      transport: async (m) => {
        sent.push(`${m.subject}\n${m.body}`);
      },
    });

    const message = sent.join("\n");
    expect(message).toContain("globex.com");
    expect(message).not.toContain("acme.com");
  });

  it("pairs a run with the same brand's previous run, not another brand's", async () => {
    // **The defect CL-501e exists for.** A probe against the real schema showed an
    // `acme.com` run pairing with `s1_globex`, because the baseline query asked for
    // "the newest completed run in this project that started before X" and a
    // three-brand patrol writes three snapshots sharing one `startedAt`.
    //
    // The consequence was quiet rather than loud: because both sides carried their
    // own `domain`, the brand-scoped key in `decideAlerts` matched **no rows**, so
    // the alert reported nothing at all. Incomplete rather than wrong — but only by
    // accident of the key widening, not by design.
    //
    // This asserts the pairing directly, because that is the thing that was wrong.
    // Asserting only "an alert was sent" would pass with a cross-brand pair on the
    // first day the two brands happened to share a prompt.
    await target("t_acme", "acme.com");
    await target("t_globex", "globex.com");

    // Three runs. Globex's sits **between** acme's two, in time — so a
    // project-scoped "newest run before this one" returns *globex*, which is
    // exactly the cross-brand pair the probe found.
    //
    // A same-`startedAt` globex would not have caught it: `lt` would exclude it
    // anyway, so the test would pass for the wrong reason. The ordering is the
    // trap.
    await snapshot("s_acme_1", T1, "t_acme");
    await answer("a1", "s_acme_1", "best crm", "acme.com leads.", {
      targetId: "t_acme",
    });
    await snapshot("s_globex_1", T2, "t_globex");
    await answer("g1", "s_globex_1", "best crm", "globex.com leads.", {
      targetId: "t_globex",
    });
    await snapshot("s_acme_2", T8, "t_acme");
    await answer("a2", "s_acme_2", "best crm", "acme.com still leads.", {
      targetId: "t_acme",
    });

    const { getLatestRunPair } =
      await import("@/server/features/geo/services/runObservations");
    const pair = await getLatestRunPair("p1", "s_acme_2");

    expect(pair?.current.snapshotId).toBe("s_acme_2");
    // Acme's own previous run — not globex's, which is newer than it.
    expect(pair?.previous?.snapshotId).toBe("s_acme_1");
  });

  it("says no comparison exists for a run with no brand", async () => {
    // Every run written before CL-501e has `target_id: null`. Rather than falling
    // back to "the previous run in the project" — which is how a run came to be
    // compared against another brand — an unattributed run reports nothing.
    //
    // This is a one-time suppression of alerts for existing projects, and it is the
    // safe direction: an alert naming the wrong brand is something a customer acts
    // on, whereas a missing one costs them a message they can still see next night.
    await target("t_acme", "acme.com");
    await snapshot("s_acme_1", T1, "t_acme");
    await answer("a1", "s_acme_1", "best crm", "acme.com leads.", {
      targetId: "t_acme",
    });
    // The current run carries no brand, as every pre-migration run does. No
    // answers are attached: the refusal happens on the snapshot lookup, so an
    // unattributed run with no rows exercises the same path a legacy run with
    // archived answers would, and keeps the fixture to one helper.
    await unattributedSnapshot("s_legacy", T2);

    const { getLatestRunPair } =
      await import("@/server/features/geo/services/runObservations");
    expect(await getLatestRunPair("p1", "s_legacy")).toBeNull();
  });

  it("never compares one brand's answer against another's", async () => {
    // **The second cross-brand flaw, in the alerting path.**
    //
    // The patrol asks *every* target in a project the same prompt set, so two
    // brands produce two answers for one prompt on one platform. Both the
    // reader's key and the decision layer's key were `platform|prompt`, so the
    // second brand's row was discarded as a duplicate and the survivor was
    // compared against whichever brand the previous run happened to keep.
    //
    // Here globex is a hit in the first run and not in the second, while acme is
    // a hit in both. Correct behaviour is exactly one alert, naming globex —
    // acme did not change. Keying on prompt alone either reports acme as having
    // lost a mention (a false alarm on a brand that never changed) or drops
    // globex's change entirely, depending on which row won the race.
    await target("t_acme", "acme.com");
    await target("t_globex", "globex.com");

    await snapshot("s1", T1);
    await answer("a1", "s1", "best crm", null, {
      targetId: "t_acme",
      source: "mentions_search",
    });
    await answer("a2", "s1", "best crm", null, {
      targetId: "t_globex",
      source: "mentions_search",
    });

    await snapshot("s2", T2);
    await answer("b1", "s2", "best crm", null, {
      targetId: "t_acme",
      source: "mentions_search",
    });
    await answer(
      "b2",
      "s2",
      "best crm",
      "Salesforce and HubSpot are the usual choices.",
      { targetId: "t_globex", source: "llm_responses" },
    );

    const { sent, transport } = collector();
    await runAlerts({ projectId: "p1", snapshotId: "s2", transport });

    const message = sent.join("\n");
    expect(message).toContain("globex.com");
    // Acme was mentioned in both runs. Reporting it as a change is the false
    // alarm this test exists to prevent.
    expect(message).not.toContain("acme.com");
  });

  it("alerts when a cited page stops being cited", async () => {
    // **The second unreachable alert, and the same shape as the first.**
    //
    // `decideAlerts` has always implemented citation diffing — it loops over
    // `before.citations` and reports a normalised URL that is gone. But the reader
    // hardcoded `citations: []`, so that loop iterated an empty list and the
    // decision layer could never produce a `citation_lost` from real data. The
    // decision code was correct, tested against hand-built observations, and fed
    // nothing it could act on.
    //
    // `alertDecision.test.ts` proves the decision is right and this proves the
    // reader supplies it — and **both passed while the feature was dead**. That is
    // the lesson: a decision layer tested only against its own fixtures cannot tell
    // you its input is unreachable.
    await target("t1", "acme.com");

    await snapshot("s1", T1);
    await answer("a1", "s1", "best crm", "Acme leads.", { targetId: "t1" });
    await citation("a1", "https://acme.com/pricing");
    await citation("a1", "https://partner.example/review");

    await snapshot("s2", T2);
    await answer("a2", "s2", "best crm", "Acme leads.", { targetId: "t1" });
    await citation("a2", "https://acme.com/pricing");

    const { sent, transport } = collector();
    await runAlerts({ projectId: "p1", snapshotId: "s2", transport });

    const message = sent.join("\n");
    // The dropped page is named, because "you lost a citation" is not actionable
    // without knowing which page.
    expect(message).toContain("partner.example");
    // The surviving one is not reported as lost.
    expect(message).not.toContain("acme.com/pricing");
  });

  it("will not use a failed run as the baseline for a later one", async () => {
    // A `failed` snapshot archives partial answers or none, so pairing against
    // one manufactures changes out of an outage: everything the good run has that
    // the broken one lacks reads as a regression. The reader's docstring claimed
    // "completed runs" while the query filtered nothing, so this was reachable.
    await target("t1", "acme.com");
    await snapshot("s1", T1);
    await answer("a1", "s1", "best crm", null, { targetId: "t1" });

    // A later run that failed part-way: same prompt, no archived answer.
    await snapshotWithStatus("s_failed", T8, "failed");

    const { sent, transport } = collector();
    const result = await runAlerts({
      projectId: "p1",
      snapshotId: "s_failed",
      transport,
    });

    // A failed run is not eligible to be the current run either, so nothing is
    // decided about it at all.
    expect(result.outcome).toBe("not_applicable");
    expect(sent).toEqual([]);
  });

  it("decides about the run the caller named, not the newest one", async () => {
    // Two runs finishing out of order. The caller names the one it just did; the
    // reader must pair *that* against its predecessor. Re-deriving "newest in the
    // project" would decide the alert about the wrong run entirely.
    await target("t1", "acme.com");
    await snapshot("s1", T1);
    await answer("a1", "s1", "best crm", null, { targetId: "t1" });
    // The newest run, which is *not* the one being alerted on.
    await snapshot("s_newest", T8);
    await answer("n1", "s_newest", "newest prompt", null, { targetId: "t1" });

    const { getLatestRunPair } =
      await import("@/server/features/geo/services/runObservations");
    const chosen = await getLatestRunPair("p1", "s1");

    // Asserted on the whole `previous` rather than `previous?.snapshotId`: `s1` is
    // the *oldest* run here, so it has no predecessor and `previous` is null.
    // Optional chaining would turn that into `undefined` and hide the difference
    // between "no baseline" and "a baseline that is somehow missing an id".
    expect(chosen?.current.snapshotId).toBe("s1");
    expect(chosen?.previous).toBeNull();
  });

  it("finds the baseline that is one step back, not the newest or the oldest", async () => {
    // Five completed runs, and the caller names the middle one. The baseline must
    // be the run immediately before it.
    //
    // **This is the test that keeps the SQL predicate honest.** An earlier version
    // loaded the whole history and picked the neighbouring element in JS; the
    // obvious way to bound that was `LIMIT 2`, which silently compares against the
    // *newest* run whenever the named one is older. Expressing "strictly before"
    // in the `WHERE` clause is both bounded and unable to make that mistake, and
    // this test is what would notice if someone reintroduced the array scan.
    await target("t1", "acme.com");
    const times = [
      new Date("2026-10-01T00:00:00.000Z"),
      new Date("2026-10-02T00:00:00.000Z"),
      new Date("2026-10-03T00:00:00.000Z"),
      new Date("2026-10-04T00:00:00.000Z"),
      new Date("2026-10-05T00:00:00.000Z"),
    ];
    for (const [i, at] of times.entries()) {
      await snapshot(`s${i}`, at);
      await answer(`a${i}`, `s${i}`, "best crm", null, { targetId: "t1" });
    }

    const { getLatestRunPair } =
      await import("@/server/features/geo/services/runObservations");

    // The middle run: its baseline is the one before it, not the newest.
    const middle = await getLatestRunPair("p1", "s2");
    expect(middle?.current.snapshotId).toBe("s2");
    expect(middle?.previous?.snapshotId).toBe("s1");

    // The newest run pairs with the one before it too — the common case.
    const newest = await getLatestRunPair("p1", "s4");
    expect(newest?.previous?.snapshotId).toBe("s3");

    // The oldest has nothing before it.
    const oldest = await getLatestRunPair("p1", "s0");
    expect(oldest?.previous).toBeNull();
  });

  it("maps each source to the verdict mentionFromAnswer gives it", async () => {
    // This asserts the *mapping*, not whether an alert fired.
    //
    // The two tests that assert "nothing was sent" pin behaviour only weakly: both
    // are also true of a broken reader. Reading the observations directly is what
    // makes a regression visible — the Live rows come back `null` instead of `true`
    // the moment someone reverts the delegation and hardcodes
    // `answerText === null ? null : true` again.
    await target("t1", "acme.com");
    await snapshot("s1", T1);
    await answer("a1", "s1", "live hit", null, { source: "mentions_search" });
    await answer("a2", "s1", "queued body", "Some answer.", {
      source: "llm_responses",
    });
    await answer("a3", "s1", "queued empty", null, {
      source: "llm_responses",
    });

    const { getLatestRunPair } =
      await import("@/server/features/geo/services/runObservations");
    // The snapshot is named, because the reader now pairs *that* run against the
    // one before it rather than re-deriving "the newest" from the project.
    const pair = await getLatestRunPair("p1", "s1");
    expect(pair).not.toBeNull();
    // Keyed by prompt rather than counted, so one wrong verdict cannot hide behind
    // another's right one.
    const byPrompt = new Map(
      [...(pair?.current.byKey.values() ?? [])].map((o) => [
        o.prompt,
        o.mentioned,
      ]),
    );

    // A Live hit is a mention *despite* carrying no body. This is the whole
    // regression: the old mapping read `answerText === null` as unobservable, so
    // this was `null` and the row could never fire an alert.
    expect(byPrompt.get("live hit")).toBe(true);

    // A queued answer is not a mention, and with no domain to read against it
    // cannot be established — unobservable, never `true`.
    expect(byPrompt.get("queued body")).toBeNull();
    expect(byPrompt.get("queued empty")).toBeNull();
  });

  it("does not call a queued answer a mention merely because it exists", async () => {
    // The other direction, and the more damaging one. A `llm_responses` row is
    // the answer to a prompt we asked, stored **whether or not the brand appears
    // in it**. The old mapping read its existence as a mention, so a project
    // running queued prompts would have been told it was mentioned in everything,
    // forever.
    await target("t1", "acme.com");
    await snapshot("s1", T1);
    await answer("q1", "s1", "best crm", "Some vendor's answer.", {
      source: "llm_responses",
      targetId: "t1",
    });
    await snapshot("s2", T2);
    await answer("q2", "s2", "best crm", "Some vendor's answer.", {
      source: "llm_responses",
      targetId: "t1",
    });
    const { sent, transport } = collector();

    await runAlerts({ projectId: "p1", snapshotId: "s2", transport });

    expect(sent).toEqual([]);
  });
});
