import { describe, expect, it } from "vitest";
import { decideAlerts, swingIsReal, type Observation } from "./alertDecision";

/**
 * Alerting's decision layer.
 *
 * The tests are almost entirely about **not alerting**. An alerting system's
 * failure mode is symmetric and quiet: a missed change is a customer who asks,
 * but a false alarm is a product that has trained its users to ignore it — and
 * then the one real alert is not read either. So the assertions below are
 * weighted towards suppression, and every one names the specific noise it rules
 * out.
 */

const BASE: Observation = {
  platform: "chat_gpt",
  prompt: "best crm software",
  domain: "acme.com",
  mentioned: true,
  sentiment: "positive",
  citations: ["https://acme.com/pricing", "https://hubspot.com"],
};

function obs(overrides: Partial<Observation> = {}): Observation {
  return { ...BASE, ...overrides };
}

describe("decideAlerts", () => {
  it("keeps two prompts on one brand apart, which is the whole point of the key", () => {
    // **The gap in this file, found by CodeRabbit and confirmed by the symptom.**
    //
    // `keyOf` was
    //   `${o.domain}|${o.platform}|${normaliseUrlForJoin(o.prompt)}`
    // — a **URL** normaliser applied to a **prompt**. `normaliseUrlForJoin` returns
    // `null` for anything that is not a URL, and `best crm software` is not a URL,
    // so the template literal stringified the `null` and **every prompt for one
    // brand and platform collapsed onto `acme.com|chat_gpt|null`.**
    //
    // Every test above passes with exactly one prompt, so none of them could see
    // it. The consequence is the worst kind: `byKey` kept one previous
    // observation, every current observation was compared against that single
    // baseline, a mention of prompt A against no mention of prompt B produced a
    // **false "mention lost" naming B**, and real changes on every other prompt
    // were silently discarded.
    //
    // So this is the first test here with more than one prompt, and it is here
    // rather than in `alertRunner` because the defect is entirely in this layer.
    const decision = decideAlerts({
      previous: [
        obs({ prompt: "alpha", mentioned: true }),
        obs({ prompt: "beta", mentioned: false }),
      ],
      current: [
        obs({ prompt: "alpha", mentioned: true }),
        obs({ prompt: "beta", mentioned: true }),
      ],
    });

    // No alert: alpha did not change, and beta's gain is a gain — not a loss.
    expect(decision.shouldAlert).toBe(false);
    // And beta is the only thing reported, named correctly.
    expect(decision.suppressed).toHaveLength(1);
    const [only] = decision.suppressed;
    expect(only?.kind).toBe("mention_gained");
    // `only.kind` narrowed to `"mention_gained"` above is what makes `only.prompt`
    // reachable: the discriminant on the *assertion* is not a type guard, so the
    // property is read through the union's own shape instead.
    if (only?.kind === "mention_gained") {
      expect(only.prompt).toBe("beta");
    }
  });

  it("does not report a loss for a prompt that merely gained elsewhere", () => {
    // The false-positive half, stated directly. Alpha is mentioned both times and
    // beta is not; with the collapsed key, beta's absence was compared against
    // alpha's presence and produced a "mention lost" for alpha — naming a prompt
    // that had not changed at all, for a customer to act on.
    const decision = decideAlerts({
      previous: [obs({ prompt: "alpha", mentioned: true })],
      current: [
        obs({ prompt: "alpha", mentioned: true }),
        obs({ prompt: "beta", mentioned: false }),
      ],
    });
    // `alerts` is only present when `shouldAlert` is true — the decision is a
    // union, not a bag of optionals, precisely so a caller cannot read alerts off
    // a decision that has none. The assertion is therefore that the decision
    // carries **no alerts at all**, which is the claim: with the collapsed key
    // this would be a `mention_lost`.
    expect(decision.shouldAlert).toBe(false);
    expect(decision.suppressed).toEqual([]);
  });

  it("stays silent when nothing changed", () => {
    const decision = decideAlerts({ previous: [obs()], current: [obs()] });
    expect(decision.shouldAlert).toBe(false);
    expect(decision.suppressed).toEqual([]);
  });

  it("alerts on a lost mention", () => {
    // The regression. Someone can act on it: the page that was in the answer
    // last week is not in it today.
    const decision = decideAlerts({
      previous: [obs()],
      current: [obs({ mentioned: false })],
    });
    expect(decision.shouldAlert).toBe(true);
    expect(decision.shouldAlert && decision.alerts[0]?.kind).toBe(
      "mention_lost",
    );
  });

  it("suppresses a gained mention, and records that it did", () => {
    // Good news is not urgent, and a nightly "you were mentioned!" for every
    // new prompt mention is how a channel gets muted. It is still *reported* in
    // `suppressed`, so the silence is auditable rather than looking like nothing
    // happened.
    const decision = decideAlerts({
      previous: [obs({ mentioned: false })],
      current: [obs({ mentioned: true })],
    });
    expect(decision.shouldAlert).toBe(false);
    expect(decision.suppressed.map((c) => c.kind)).toEqual(["mention_gained"]);
  });

  it("never reads a pending vendor task as a lost mention", () => {
    // **The most damaging thing this file could do.** `mentioned: null` means
    // the task has not come back yet, not that the brand was absent. Diffing
    // `true` against `null` tells a customer they lost a mention that was never
    // looked up — and they will act on it.
    const decision = decideAlerts({
      previous: [obs({ mentioned: true })],
      current: [obs({ mentioned: null })],
    });
    expect(decision.shouldAlert).toBe(false);
    expect(decision.suppressed).toEqual([]);
  });

  it("never reads a pending task on the previous run as a mention either", () => {
    // Symmetric guard: `null` → `false` is not a gain, it is a baseline we
    // never established.
    const decision = decideAlerts({
      previous: [obs({ mentioned: null })],
      current: [obs({ mentioned: false })],
    });
    expect(decision.shouldAlert).toBe(false);
  });

  it("stays silent on the first run, with no baseline", () => {
    // A first run establishes a reference. Diffing against nothing reports every
    // item as new, which is a storm that says only "we started monitoring you" —
    // news to nobody who pressed the button.
    const decision = decideAlerts({ previous: null, current: [obs()] });
    expect(decision.shouldAlert).toBe(false);
  });

  it("stays silent when the previous run exists but is empty", () => {
    // Same reasoning, and a different case: a run that produced no rows is not
    // a baseline saying "you were mentioned nowhere".
    const decision = decideAlerts({ previous: [], current: [obs()] });
    expect(decision.shouldAlert).toBe(false);
  });

  it("alerts on a lost citation", () => {
    const decision = decideAlerts({
      previous: [obs()],
      current: [obs({ citations: ["https://acme.com/pricing"] })],
    });
    expect(decision.shouldAlert).toBe(true);
    expect(decision.shouldAlert && decision.alerts[0]?.kind).toBe(
      "citation_lost",
    );
  });

  it("does not treat the same page under a new utm as a lost citation", () => {
    // The inclusion–citation gap's bug, in a new place. `?utm_source=openai` is
    // in the vendor's *documented* payloads, so exact string comparison would
    // report a loss every single run and a gain every single run, forever.
    const decision = decideAlerts({
      previous: [obs({ citations: ["https://acme.com/pricing"] })],
      current: [
        obs({ citations: ["https://acme.com/pricing?utm_source=openai"] }),
      ],
    });
    expect(decision.shouldAlert).toBe(false);
  });

  it("does not alert on a citation that only moved rank", () => {
    // Rank churn between weekly runs is the normal texture of a model answer.
    // Alerting on it is how you get 200 notifications a month, none of them
    // mattering.
    const decision = decideAlerts({
      previous: [obs({ citations: ["https://a.com", "https://b.com"] })],
      current: [obs({ citations: ["https://b.com", "https://a.com"] })],
    });
    expect(decision.shouldAlert).toBe(false);
  });

  it("does not alert on a gained citation", () => {
    // A model adding a source is mildly good news, not a regression someone is
    // waiting up for.
    const decision = decideAlerts({
      previous: [obs({ citations: ["https://a.com"] })],
      current: [obs({ citations: ["https://a.com", "https://b.com"] })],
    });
    expect(decision.shouldAlert).toBe(false);
  });

  it("does not alert on a sentiment swing the first time it is seen", () => {
    // Our sentiment classifier is a heuristic. A single flip on a near-neutral
    // sentence is a coin flip, and reporting it would make every third alert a
    // false alarm — the rate at which people stop reading alerts.
    const decision = decideAlerts({
      previous: [obs({ sentiment: "positive" })],
      current: [obs({ sentiment: "negative" })],
    });
    expect(decision.shouldAlert).toBe(false);
  });

  it("alerts on a sentiment swing that repeats", () => {
    // Two consecutive agreeing observations is the cheapest test that materially
    // beats a coin flip, and it costs one run of latency.
    const decision = decideAlerts({
      previous: [obs({ sentiment: "positive" })],
      current: [obs({ sentiment: "negative" })],
      recentSwings: [{ from: "positive", to: "negative" }],
    });
    expect(decision.shouldAlert).toBe(true);
    expect(decision.shouldAlert && decision.alerts[0]?.kind).toBe(
      "sentiment_swing",
    );
  });

  it("never infers sentiment when either side has none", () => {
    // "Unknown" is not a value to compare. Reading null as a sentiment would
    // invent a swing on every answer we could not classify.
    const decision = decideAlerts({
      previous: [obs({ sentiment: null })],
      current: [obs({ sentiment: "negative" })],
    });
    expect(decision.shouldAlert).toBe(false);
  });

  it("matches on the prompt, not on iteration order", () => {
    // The runs are not aligned — the prompt set changes between runs. Pairing by
    // index would report a loss for every prompt that moved, which is a storm
    // generated entirely by the diffing.
    const decision = decideAlerts({
      previous: [
        obs({ prompt: "a" }),
        obs({ prompt: "b", mentioned: true }),
        obs({ prompt: "c" }),
      ],
      current: [
        obs({ prompt: "c" }),
        obs({ prompt: "a" }),
        obs({ prompt: "b", mentioned: false }),
      ],
    });
    expect(decision.shouldAlert).toBe(true);
    if (!decision.shouldAlert) return;
    expect(decision.alerts).toHaveLength(1);
    expect(decision.alerts[0]).toMatchObject({
      kind: "mention_lost",
      prompt: "b",
    });
  });

  it("ignores a prompt present in only one run", () => {
    // A prompt added or removed from the set is a configuration change, not a
    // visibility event. Reporting it would make every prompt-set edit look like
    // a brand event.
    const decision = decideAlerts({
      previous: [obs({ prompt: "a" })],
      current: [obs({ prompt: "a" }), obs({ prompt: "brand new" })],
    });
    expect(decision.shouldAlert).toBe(false);
  });

  it("keeps the loss ahead of the gain in the same run", () => {
    // A reader who stops after the first line must see the thing that was lost,
    // not the thing that appeared. Same ordering rule as `answerDiff`.
    const decision = decideAlerts({
      previous: [obs({ prompt: "a" }), obs({ prompt: "b", mentioned: false })],
      current: [obs({ prompt: "a", mentioned: false }), obs({ prompt: "b" })],
    });
    expect(decision.shouldAlert).toBe(true);
    if (decision.shouldAlert) {
      expect(decision.alerts[0]?.kind).toBe("mention_lost");
      expect(decision.suppressed.map((c) => c.kind)).toEqual([
        "mention_gained",
      ]);
    }
  });

  it("keeps platforms separate", () => {
    // A prompt on ChatGPT losing a mention says nothing about Gemini, and
    // pooling them would report a swing that happened on neither.
    const decision = decideAlerts({
      previous: [obs({ platform: "chat_gpt" }), obs({ platform: "google" })],
      current: [
        obs({ platform: "chat_gpt", mentioned: false }),
        obs({ platform: "google" }),
      ],
    });
    expect(decision.shouldAlert).toBe(true);
    if (decision.shouldAlert) {
      expect(decision.alerts).toHaveLength(1);
      expect(decision.alerts[0]?.platform).toBe("chat_gpt");
    }
  });
});

describe("swingIsReal", () => {
  it("needs the same transition twice, in the same direction", () => {
    expect(swingIsReal({ from: "positive", to: "negative" }, [])).toBe(false);
    expect(
      swingIsReal({ from: "positive", to: "negative" }, [
        { from: "positive", to: "negative" },
      ]),
    ).toBe(true);
  });

  it("does not count a swing in the opposite direction", () => {
    // The classifier is oscillating. Two flips in two directions is a coin
    // flip, not a trend, and the most alarming shape for a customer who is
    // trying to decide whether to act.
    expect(
      swingIsReal({ from: "positive", to: "negative" }, [
        { from: "negative", to: "positive" },
      ]),
    ).toBe(false);
  });

  it("does not count a swing through an unrelated state", () => {
    expect(
      swingIsReal({ from: "positive", to: "negative" }, [
        { from: "neutral", to: "negative" },
      ]),
    ).toBe(false);
  });
});
