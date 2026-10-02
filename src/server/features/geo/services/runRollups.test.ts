/**
 * `writeRunRollups` — the reduction behind every number the GEO page shows.
 *
 * This module had no test when it was written, and it is exactly the shape that
 * looks finished while being wrong: it is small, it is called from one place, and
 * every value it produces is read by several surfaces that have tests of their own
 * and none of them can tell a wrong rollup from a right one.
 *
 * **Every test here is a claim the module's docstring makes**, and each one is a way
 * the number could come out wrong in the flattering direction — which is the
 * direction this product has been guarding against since CL-501d.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import { writeRunRollups } from "./runRollups";
import type { GeoAnswerInsert } from "@/server/features/geo/repositories/GeoAnswerRepository";
import type { GeoPlatform } from "@/server/features/geo/repositories/GeoSetupRepository";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const insertTargetMetrics = vi.fn(async (_rows: never[]) => {});
// **Both parameters declared**, and that is load-bearing rather than pedantic: a
// `vi.fn(() => [])` takes no arguments, so it recorded *none* — and every citation
// assertion then read an empty list, which looked exactly like a module that never
// writes them. A spy whose signature does not match the real function cannot see the
// real function's arguments.
const insertCitationDomains = vi.fn(
  (_tx: unknown, _rows: never[]) => [] as never[],
);

vi.mock("@/server/features/geo/repositories/GeoRunRepository", () => ({
  GeoRunRepository: {
    insertTargetMetrics: (rows: never[]) => insertTargetMetrics(rows),
    // `(tx, rows)` — the repository takes a transaction first, so recording
    // argument 0 as "the rows" would have made every citation assertion read an
    // empty list and look like a module that never writes them.
    insertCitationDomains: (tx: unknown, rows: never[]) =>
      insertCitationDomains(tx, rows),
  },
}));

vi.mock("@/db/runBatch", () => ({
  // The repository returns builders, and the real `runBatch` needs a database.
  // Composing them is what is being tested; executing them is not.
  runBatch: async (build: (tx: unknown) => unknown[]) => {
    build({});
  },
}));

const NOW = "2026-10-01T00:00:00.000Z";

let clock: ReturnType<typeof vi.useFakeTimers>;
beforeEach(() => {
  insertTargetMetrics.mockClear();
  insertCitationDomains.mockClear();
  clock = vi.useFakeTimers();
  clock.setSystemTime(new Date(NOW));
});
afterEach(() => {
  clock.useRealTimers();
});

/**
 * One archived answer, with only the fields the rollup reads.
 *
 * **`citations` is a sibling of `answer`, not a field of it** — `GeoAnswerInsert` is
 * `{ answer, citations?, retrievals?, fanOutQueries? }`. The first version spread
 * `over` into the answer only, so three citation tests passed
 * `citations: [{ … }]` and the fixture silently supplied `[]` instead. The symptom
 * was three tests reporting "the module never writes citation rows" — which is
 * exactly what the module *was* doing wrong for a different reason two lines earlier,
 * so the two bugs reinforced each other convincingly.
 */
/**
 * Typed against the real `GeoAnswerInsert`, **not** `Record<string, unknown>`.
 *
 * The loose version widened `source` to `string`, which `GeoAnswerInsert` rejects —
 * so `tsc` caught a fixture that had been passing every assertion. Naming the type
 * here means a test that drifts from the repository's shape fails on the *type* rather
 * than on an assertion that happens not to read the drifted field.
 */
type AnswerOverrides = Partial<
  GeoAnswerInsert["answer"] & { platform: GeoPlatform }
>;

const answer = (
  over: AnswerOverrides = {},
  citations: NonNullable<GeoAnswerInsert["citations"]> = [],
): GeoAnswerInsert => ({
  answer: {
    id: "a1",
    projectId: "p1",
    platform: "chat_gpt",
    source: "llm_responses",
    answerText: "Acme is the leader in CRM software.",
    prompt: "best crm",
    locationCode: 2840,
    languageCode: "en",
    targetId: "t1",
    answeredAt: "2026-10-01T00:00:00.000Z",
    ...over,
  },
  citations,
});

const run = (
  answers: GeoAnswerInsert[],
  over: Partial<Parameters<typeof writeRunRollups>[0]> = {},
) =>
  writeRunRollups({
    projectId: "p1",
    snapshotId: "s1",
    targetId: "t1",
    domain: "acme.com",
    brandName: "Acme",
    answers,
    ...over,
  });

/** The metrics rows the run produced, in platform order. */
const metricsRows = () =>
  (insertTargetMetrics.mock.calls[0]?.[0] ?? []) as Array<{
    platform: string;
    mentions: number;
    aiSearchVolume: number | null;
    targetId: string;
  }>;

/** The citation rows the run produced, as platform+domain+mentions. */
const citationRows = () =>
  (
    (insertCitationDomains.mock.calls[0]?.[1] ?? []) as Array<{
      platform: string;
      domain: string;
      mentions: number;
    }>
  ).map((r) => `${r.platform}|${r.domain}|${r.mentions}`);

describe("writeRunRollups", () => {
  it("counts a mention only when the brand is actually named", async () => {
    // The claim that matters most. `geo_answers` stores a row whether or not the
    // brand was named in it, so a row count would report a perfect score for a run
    // that archived ten answers and mentioned the brand in none of them.
    await run([
      answer({ id: "a1", answerText: "Acme is the leader." }),
      answer({
        id: "a2",
        answerText: "Salesforce and HubSpot lead the market.",
      }),
    ]);

    const rows = metricsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mentions).toBe(1);
  });

  it("counts an unanswerable answer as neither a mention nor an absence", async () => {
    // `mentionFromAnswer` returns null for a row it cannot read, and null is not a
    // zero. This test pins the refusal reaching the rollup rather than being
    // flattened somewhere in between.
    await run([answer({ answerText: null })]);

    // One platform row, with zero mentions — the honest figure for "we asked and
    // could not read the answer", which is not the same as "the brand was absent".
    expect(metricsRows()[0]?.mentions).toBe(0);
  });

  it("treats a mentions_search row as evidence in itself", async () => {
    // The vendor only returns prompts that named the brand, so the row's existence
    // is the evidence — and the rollup must not re-judge it from absent text.
    await run([answer({ source: "mentions_search", answerText: null })]);

    expect(metricsRows()[0]?.mentions).toBe(1);
  });

  it("keeps platforms apart, because a total would be a fabricated number", async () => {
    // `ai_search_volume` is modelled differently per vendor and the column says so.
    // Summing mentions across platforms would report "5 mentions" for a run that
    // said nothing about the combined figure.
    await run([
      answer({ id: "a1", platform: "chat_gpt", answerText: "Acme leads." }),
      answer({ id: "a2", platform: "chat_gpt", answerText: "Acme again." }),
      answer({
        id: "a3",
        platform: "google_ai_overview",
        answerText: "Salesforce leads.",
      }),
    ]);

    const rows = metricsRows();
    expect(rows).toHaveLength(2);
    const byPlatform = new Map(rows.map((r) => [r.platform, r.mentions]));
    expect(byPlatform.get("chat_gpt")).toBe(2);
    expect(byPlatform.get("google_ai_overview")).toBe(0);
  });

  it("counts a citing domain once per platform however many answers cited it", async () => {
    // The finding is "how many domains does the AI cite us *from*", and a domain
    // cited in six answers is still one domain to go earn.
    await run([
      answer({ id: "a1" }, [{ url: "https://g2.com/x", domain: "g2.com" }]),
      answer({ id: "a2", answerText: "Acme leads." }, [
        { url: "https://g2.com/y", domain: "g2.com" },
      ]),
    ]);

    expect(citationRows()).toEqual(["chat_gpt|g2.com|2"]);
  });

  it("does not merge one platform's citing domains into another's row", async () => {
    await run([
      answer({ id: "a1" }, [{ url: "https://g2.com/x", domain: "g2.com" }]),
      answer({ id: "a2", platform: "google_ai_overview" }, [
        { url: "https://g2.com/x", domain: "g2.com" },
      ]),
    ]);

    // **Set comparison, not a sorted list.** oxlint forbids `.sort()` and this
    // project targets a lib without `.toSorted()`, so ordering was a property of the
    // gate configuration rather than of the answer. The claim is "these two rows
    // exist, one per platform" — which a `Set` states exactly.
    expect(new Set(citationRows())).toEqual(
      new Set(["chat_gpt|g2.com|1", "google_ai_overview|g2.com|1"]),
    );
  });

  it("derives a domain from a citation that carries no resolved host", async () => {
    await run([answer({}, [{ url: "https://www.G2.com/reviews/acme?x=1" }])]);

    expect(citationRows()).toEqual(["chat_gpt|g2.com|1"]);
  });

  it("writes no demand figure, because the endpoint reports none", async () => {
    // `llm_mentions/search` returns a mention count and no demand figure. A `0`
    // here would claim we looked for demand and found none, which is a claim about
    // the world rather than about our archive.
    await run([answer()]);

    for (const row of metricsRows()) {
      expect(row.aiSearchVolume).toBeNull();
    }
  });

  it("writes nothing at all when a run produced no answers", async () => {
    // A run that archived nothing has no metrics — and an empty list is not a row
    // saying zero mentions.
    await run([]);

    expect(insertTargetMetrics).not.toHaveBeenCalled();
    expect(insertCitationDomains).not.toHaveBeenCalled();
  });

  it("refuses a platform the column's enum would reject", async () => {
    // The value came from our own enum, so this cannot happen today — which is
    // exactly why it is tested: an unreachable branch that is never exercised is
    // the one that breaks when someone widens the vocabulary.
    //
    // **`as GeoPlatform` is the point, not a shortcut.** With the fixture typed
    // against `GeoAnswerInsert`, this line would not compile — which is the type
    // system correctly saying "you cannot get here from typed code". The runtime
    // guard still earns its keep for the path that *is* reachable: a row read back
    // out of the database, or a widened vocabulary in one place and not another. So
    // the cast states the premise out loud rather than hiding it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the premise: this value cannot come from typed code, which is why the runtime guard is the thing under test
    const impossible = "bing_copilot" as GeoPlatform;
    await expect(run([answer({ platform: impossible })])).rejects.toThrow(
      AppError,
    );
  });

  it("keys the metrics row on the target, not on the project", async () => {
    // A project can monitor several brands, so a row keyed on the project alone
    // would merge two brands' visibility into one figure — the same mistake CL-501e
    // recorded for `geo_snapshots.target_id`.
    await run([answer()], { targetId: "t-brand-2" });

    expect(metricsRows()[0]?.targetId).toBe("t-brand-2");
  });
});
