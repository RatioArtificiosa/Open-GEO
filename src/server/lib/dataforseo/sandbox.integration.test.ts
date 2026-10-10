import { describe, expect, it, vi, beforeAll } from "vitest";
import { buildLlmTarget } from "./shared";

/**
 * The sandbox integration test — every DataForSEO path our client uses, driven
 * through our own fetchers, against the vendor's free sandbox.
 *
 * ## Why this exists
 *
 * The live DataForSEO account holds **$1.00**. A mis-shaped request costs real
 * money, and a whole end-to-end run costs more than the account holds. The
 * sandbox validates every request exactly as production does — auth, envelope,
 * required fields, task limits — and returns canned rows at **zero cost**.
 *
 * So this is the test that answers, without spending anything:
 *
 * 1. Is the **path** right? A typo'd path is a 404 on the sandbox, exactly as in
 *    production, and it never bills.
 * 2. Is the **request shape** right? `40503 POST Data Is Invalid` is the
 *    sandbox's answer, and it is the same answer production gives.
 * 3. Does our **Zod schema** parse the real response? The fixtures are the vendor's
 *    own envelope, so a schema that rejects them is a schema that will reject
 *    production.
 *
 * ## Why it drives the client rather than issuing curl
 *
 * A hand-written request proves the endpoint works. Driving the app's fetcher
 * proves *our* request shape and *our* parser work. The two failures are
 * completely different, and only the second one costs money in production.
 *
 * The first draft of this read a path list and curled each one; it reported
 * `HTTP 200` for eight `llm_mentions` paths while the vendor was actually
 * answering `40503 POST Data Is Invalid` on every one of them, because the
 * request body was wrong. **HTTP 200 is not a passing test** — DataForSEO answers
 * a logical failure with HTTP 200 and puts the outcome in `status_code`.
 *
 * ## Why it is env-gated
 *
 * `DATAFORSEO_SANDBOX_SMOKE=true` turns it on. Without it the file is skipped,
 * because CI has no vendor credentials and a test that needs the network is not a
 * unit test. Run it deliberately:
 *
 *   DATAFORSEO_SANDBOX_SMOKE=true \
 *   DATAFORSEO_API_KEY=<base64 login:password> \
 *   pnpm test:ci src/server/lib/dataforseo/sandbox.integration.test.ts
 *
 * It reads credentials from `process.env` rather than the worker env because it
 * runs in Node, not in a worker — the same reason it mocks `runtime-env`.
 */

const RUN = process.env.DATAFORSEO_SANDBOX_SMOKE === "true";

// The transport reads the API key through runtime-env, so the mock supplies it
// from the environment. Both getters, or the module fails on a missing
// variable — the documented shape from core.test.ts and concurrency.test.ts.
vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => process.env.DATAFORSEO_API_KEY ?? ""),
  getOptionalEnvValue: vi.fn(
    async () => process.env.DATAFORSEO_BASE_URL ?? undefined,
  ),
}));

vi.mock("@/server/lib/posthog", () => ({ captureServerEvent: vi.fn() }));

/**
 * The sandbox host. Set before any fetcher module is imported, because
 * `dataforseoBaseUrl()` is read per request — but the import itself must not
 * fail, so the key must already be in the environment.
 */
beforeAll(() => {
  process.env.DATAFORSEO_BASE_URL ??= "https://sandbox.dataforseo.com";
});

/**
 * The request shape, built with the repo's own factory.
 *
 * **Not hand-written.** The first version of this file passed
 * `target: [{ domain: "hubspot.com" }]` — an array where `LlmTarget` is an object —
 * so `llmMentionsRequest` wrapped it as `[[{...}]]` and the vendor answered
 * *"Exactly one of 'domain' or 'keyword' must be provided"*. That looked exactly
 * like a bug in our client and was a bug in the test.
 *
 * `buildLlmTarget` is the shared factory every production caller uses, so using
 * it here means the shape under test is the shape we ship. When a factory exists,
 * a test that hand-rolls the shape is testing its own idea of the shape.
 */
const MENTIONS_INPUT = {
  target: buildLlmTarget({ type: "domain", value: "hubspot.com" }),
  platform: "chat_gpt" as const,
  locationCode: 2840,
  languageCode: "en",
};

describe.skipIf(!RUN)("the DataForSEO sandbox", () => {
  it("answers a valid LLM Mentions target_metrics request", async () => {
    // The core GEO read, and the one whose path our client spells
    // `target_metrics`. If the sandbox 404s, our path is wrong and no
    // production call would ever have worked.
    const { fetchLlmTargetMetrics } = await import("./ai-mentions");

    const response = await fetchLlmTargetMetrics(MENTIONS_INPUT);

    // `fetchLlmTargetMetrics` returns the whole `DataforseoApiResponse`, so the
    // parsed payload is `.data`. Asserting on the response itself is the shape
    // mismatch the first version made — it compared an envelope against an array.
    expect(response.data).toBeTruthy();
  });

  it("answers a valid AI Mode request for the platform our patrol uses", async () => {
    const { fetchAiModeAnswer } = await import("./ai-mode");

    const result = await fetchAiModeAnswer({
      keyword: "best crm for small teams",
      locationCode: 2840,
      languageCode: "en",
    });

    expect(result).toBeTruthy();
  });

  it("answers a Labs keyword_overview request, which the nightly capture uses", async () => {
    const { fetchKeywordOverview } = await import("./labs");

    const response = await fetchKeywordOverview({
      keywords: ["crm software"],
      locationCode: 2840,
      languageCode: "en",
    });

    // Every fetcher returns the whole `DataforseoApiResponse`; the parsed
    // payload is `.data`. The first version of this file asserted `Array.isArray`
    // on the *response* twice, which is the same shape mistake arriving from two
    // directions — and it reads as a failing endpoint rather than a failing test.
    expect(response.data).toBeTruthy();
    expect(Array.isArray(response.data)).toBe(true);
  });

  it("answers a backlinks summary request, so the lead list can be benchmarked", async () => {
    const { fetchBacklinksSummary } = await import("./backlinks");

    const result = await fetchBacklinksSummary({ target: "hubspot.com" });

    expect(result).toBeTruthy();
  });

  it("reports an invalid body as an error rather than a shape mismatch", async () => {
    // **The negative control.** If a deliberately invalid request returned a
    // parsed result, the sandbox would not be validating and this whole file
    // would be theatre. DataForSEO answers a bad body with `40503`, which our
    // `assertOk` surfaces as a thrown error rather than an empty result — and the
    // distinction matters, because an empty result is what "no mentions" looks
    // like, and a vendor rejection must never be read as that.
    const { fetchLlmTargetMetrics } = await import("./ai-mentions");

    // **A type-valid input carrying an invalid value**, so no cast is needed to
    // build it: the factory types it as `LlmTarget`, and an empty domain is the
    // vendor's own `40503` case. The first version passed `{} as never`, which the
    // type-aware linter rejects — and the lint was right, because a `never` input
    // is testing TypeScript rather than the vendor.
    //
    // Either rejection is a pass: our own guard refusing it before the request,
    // or the sandbox refusing it after. Both mean an invalid body cannot come
    // back as an empty result.
    await expect(
      fetchLlmTargetMetrics({
        target: buildLlmTarget({ type: "domain", value: "" }),
        platform: "chat_gpt",
        locationCode: 2840,
        languageCode: "en",
      }),
    ).rejects.toThrow();
  });

  // ── The three paths suspected of being wrong ──────────────────────────────
  //
  // `aggregated_metrics`, `top_pages` and `cross_aggregated_metrics` do not appear
  // in the vendor-assistant transcript at `docs/SOFIA_AI_OPTIMIZATION_CONVERSATION.md`,
  // which listed `target_metrics`, `top_mentioned_pages`, `top_mentioned_domains`
  // and `multi_target_metrics`. That looked like the client using invented paths —
  // the kind of error that ships broken for as long as nobody calls it.
  //
  // **It is not an error. All three answer 20000 on the sandbox.** The transcript's
  // list was incomplete, not authoritative.
  //
  // The failure that produced the suspicion is recorded because it looked exactly
  // like evidence: a probe reported HTTP 401 on *every* `llm_mentions` path,
  // including the known-good `target_metrics`. The cause was a typo in the probe's
  // own shell command — `../../.env` instead of `../.env` from `Open-GEO/` — so the
  // API key was empty and the request went to production with no credentials.
  // **A uniformly failing probe usually means the probe is broken, not the system**,
  // and the giveaway was `target_metrics` failing alongside endpoints already proven
  // good.

  it("answers llm_mentions/aggregated_metrics, absent from the vendor transcript", async () => {
    const { fetchLlmAggregatedMetrics } = await import("./ai");

    const response = await fetchLlmAggregatedMetrics({
      target: MENTIONS_INPUT.target,
      platform: MENTIONS_INPUT.platform,
      locationCode: MENTIONS_INPUT.locationCode,
      languageCode: MENTIONS_INPUT.languageCode,
    });

    expect(response.data).toBeTruthy();
  });

  it("answers llm_mentions/top_pages, also absent from the transcript", async () => {
    const { fetchLlmTopPages } = await import("./ai");

    const response = await fetchLlmTopPages({
      target: MENTIONS_INPUT.target,
      platform: MENTIONS_INPUT.platform,
      locationCode: MENTIONS_INPUT.locationCode,
      languageCode: MENTIONS_INPUT.languageCode,
    });

    expect(response.data).toBeTruthy();
  });

  it("answers cross_aggregated_metrics with its own group shape", async () => {
    // The only one of the three needing a different body: `targets` (plural, an
    // array of groups), not `target`. A probe that sent the single-target shape
    // got `40501 Invalid Field: 'targets' is required` — the sandbox correctly
    // rejecting the body, not the path missing. Same answer on the vendor's own
    // `multi_target_metrics`, which is the same shape under a different name.
    const { fetchLlmCrossAggregatedMetrics } = await import("./ai");

    const response = await fetchLlmCrossAggregatedMetrics({
      groups: [
        { key: "us", target: MENTIONS_INPUT.target },
        { key: "uk", target: MENTIONS_INPUT.target },
      ],
      platform: MENTIONS_INPUT.platform,
      locationCode: MENTIONS_INPUT.locationCode,
      languageCode: MENTIONS_INPUT.languageCode,
    });

    expect(response.data).toBeTruthy();
  });
});
