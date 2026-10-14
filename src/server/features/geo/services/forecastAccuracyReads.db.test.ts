/**
 * The forecast scoreboard, against a real database.
 *
 * ## Why this one is a database test and the sweep's is not
 *
 * The sweep's job is arithmetic over injected inputs, so its failures are shapes of
 * input. This module's job is a **join across the table's own orderings** — the row
 * standing on a given day, per subject, newest-qualifying — and every one of those
 * guarantees lives in SQL. A mocked query builder returns whatever it was told to,
 * which is precisely the shape of the bug this file exists to catch: an `asOfFor`
 * that returned the newest row *after* the day being scored would score today's
 * opinion against today's fact, and it would always agree.
 *
 * The harness is shared with `forecastTableGuarantees.db.test.ts` and lives in
 * `forecastDbHarness.ts`; the reason it is a module is in its header.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  FORECAST_KINDS,
  FORECAST_MODEL_VERSION,
  type ForecastSnapshotRow,
} from "@/server/features/geo/services/forecastSnapshot";
import {
  clearForecastRows,
  FORECAST_TEST_DOMAIN,
  FORECAST_TEST_TODAY,
  seedAnswers,
  startForecastTestDb,
} from "./forecastDbHarness";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const TODAY = FORECAST_TEST_TODAY;

let harness: Awaited<ReturnType<typeof startForecastTestDb>>;

/** Write one dated row straight through the repository, as the sweep would. */
async function write(
  input: Partial<ForecastSnapshotRow> & { issuedOn: string; domain?: string },
) {
  const row: ForecastSnapshotRow = {
    projectId: "proj-1",
    domain: input.domain ?? FORECAST_TEST_DOMAIN,
    kind: FORECAST_KINDS.visibilityPace,
    subject: "chat_gpt",
    modelVersion: FORECAST_MODEL_VERSION,
    horizonDays: 90,
    shareBp: 4000,
    lowBp: 3000,
    highBp: 5000,
    perWeekBp: 400,
    nowBp: 3400,
    basedOn: 40,
    basedOnWeeks: 12,
    confidence: "moderate",
    note: null,
    ...input,
  };
  await harness.ForecastSnapshotsRepository.insertSnapshot(row);
}

beforeAll(async () => {
  harness = await startForecastTestDb((db) => {
    vi.doMock("@/db", () => ({ db }));
  });
});

afterAll(() => {
  harness.client.close();
});

beforeEach(async () => {
  await clearForecastRows(harness.client);
});

describe("readForecastAccuracy", () => {
  it("refuses when the brand has no measured runs, and says so rather than returning empty panels", async () => {
    const result = await harness.readForecastAccuracy({
      projectId: "proj-1",
      domain: FORECAST_TEST_DOMAIN,
      today: TODAY,
      platforms: [],
    });

    expect(result.rows).toEqual([]);
    expect(result.projected).toBeNull();
    expect(result.emptyReason).toContain("no measured runs");
  });

  it("withholds a projection whose horizon has not elapsed", async () => {
    // Three days old, over a 90-day band. Scoring it now would compare a
    // projection with three days of the window it was quoted for.
    await seedAnswers(harness.client);
    await write({ issuedOn: "2026-10-11" });

    const result = await harness.readForecastAccuracy({
      projectId: "proj-1",
      domain: FORECAST_TEST_DOMAIN,
      today: TODAY,
      platforms: ["chat_gpt"],
    });

    expect(result.rows).toEqual([]);
    expect(result.emptyReason).toContain("old enough to score");
  });

  it("scores a projection whose horizon has elapsed", async () => {
    await seedAnswers(harness.client);
    await write({ issuedOn: "2026-07-16" });

    const result = await harness.readForecastAccuracy({
      projectId: "proj-1",
      domain: FORECAST_TEST_DOMAIN,
      today: TODAY,
      platforms: ["chat_gpt"],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.verdict).not.toBe("too-early");
    expect(result.rows[0]?.issuedOn).toBe("2026-07-16");
    expect(result.rows[0]?.horizonDays).toBe(90);
    // The actual is the measured share, and it is present rather than null: the
    // archive has answers with a denominator, so there is something to score.
    expect(result.rows[0]?.actualShareBp).not.toBeNull();
  });

  it("includes the waiting projection only when the caller asks for it", async () => {
    await seedAnswers(harness.client);
    await write({ issuedOn: "2026-10-11" });

    const result = await harness.readForecastAccuracy({
      projectId: "proj-1",
      domain: FORECAST_TEST_DOMAIN,
      today: TODAY,
      platforms: ["chat_gpt"],
      includePending: true,
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.verdict).toBe("too-early");
    // And it names when the row becomes scorable, so "not yet" is a date rather
    // than a shrug.
    expect(result.rows[0]?.scorableOn).toBe("2027-01-09");
  });

  it("scores the row that was standing on the day the horizon ended, not the one written after", async () => {
    // The older row was made 90+ days before today and is the one whose horizon has
    // elapsed. A newer row was written three days ago, inside the horizon — it is
    // the row `asOfFor` must **not** return, because it would be scoring today's
    // opinion against today's fact.
    await seedAnswers(harness.client);
    await write({ issuedOn: "2026-07-16", shareBp: 4000 });
    await write({ issuedOn: "2026-10-11", shareBp: 9000 });

    const result = await harness.readForecastAccuracy({
      projectId: "proj-1",
      domain: FORECAST_TEST_DOMAIN,
      today: TODAY,
      platforms: ["chat_gpt"],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.issuedOn).toBe("2026-07-16");
    expect(result.rows[0]?.predictedShareBp).toBe(4000);
  });

  it("orders the scorable rows before the pending ones", async () => {
    await seedAnswers(harness.client);
    await write({ issuedOn: "2026-07-16", shareBp: 4000 });
    await write({ issuedOn: "2026-10-11", shareBp: 9000 });
    await write({ issuedOn: "2026-10-01", shareBp: 5000 });

    const result = await harness.readForecastAccuracy({
      projectId: "proj-1",
      domain: FORECAST_TEST_DOMAIN,
      today: TODAY,
      platforms: ["chat_gpt"],
      includePending: true,
    });

    const verdicts = result.rows.map((row) => row.verdict);
    expect(verdicts[0]).not.toBe("too-early");
    expect(verdicts).toContain("too-early");
    // The pending rows all sort after the scored one.
    const firstPending = verdicts.indexOf("too-early");
    const firstScored = verdicts.findIndex((v) => v !== "too-early");
    expect(firstScored).toBeLessThan(firstPending);
  });

  it("selects the newest horizon-eligible row even once the history passes the read limit", async () => {
    // The read is bounded, and bounding it the wrong way freezes the score forever:
    // taking the *oldest* 200 rows means the newest eligible row is outside the window
    // once a platform has more than that, and the panel keeps scoring an early
    // forecast while every newer one is invisible. This writes past the limit and
    // asserts the newest row is still the one scored.
    await seedAnswers(harness.client);
    for (let index = 0; index < 210; index += 1) {
      const issuedOn = new Date(
        Date.parse("2024-01-01T00:00:00Z") + index * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      await write({ issuedOn, shareBp: 1000 + index });
    }

    const result = await harness.readForecastAccuracy({
      projectId: "proj-1",
      domain: FORECAST_TEST_DOMAIN,
      today: TODAY,
      platforms: ["chat_gpt"],
    });

    expect(result.rows).toHaveLength(1);
    // The newest row is dated 2024-07-28, well inside the 90-day horizon of today.
    expect(result.rows[0]?.predictedShareBp).toBe(1209);
  });

  it("names the projection the headline comes from, with the band it speaks over", async () => {
    await seedAnswers(harness.client);
    await write({ issuedOn: "2026-07-16", subject: "chat_gpt" });

    const result = await harness.readForecastAccuracy({
      projectId: "proj-1",
      domain: FORECAST_TEST_DOMAIN,
      today: TODAY,
      platforms: ["chat_gpt"],
    });

    expect(result.projected).not.toBeNull();
    expect(result.projected?.subject).toBe("chat_gpt");
    expect(result.projected?.horizonDays).toBe(90);
  });

  it("treats a platform with no stored forecast as absent rather than as a zero", async () => {
    await seedAnswers(harness.client);
    await write({ issuedOn: "2026-07-16", subject: "chat_gpt" });

    const result = await harness.readForecastAccuracy({
      projectId: "proj-1",
      domain: FORECAST_TEST_DOMAIN,
      today: TODAY,
      platforms: ["chat_gpt", "perplexity"],
    });

    // Only the platform with a row appears; the other is not silently scored as 0%.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.subject).toBe("chat_gpt");
  });

  it("reports a reading rather than a score when the stored projection declined", async () => {
    await seedAnswers(harness.client);
    await write({
      issuedOn: "2026-07-16",
      shareBp: null,
      lowBp: null,
      highBp: null,
    });

    const result = await harness.readForecastAccuracy({
      projectId: "proj-1",
      domain: FORECAST_TEST_DOMAIN,
      today: TODAY,
      platforms: ["chat_gpt"],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.verdict).toBe("no-forecast");
    expect(result.rows[0]?.errorBp).toBeNull();
    expect(result.rows[0]?.summary).toContain("declined to give a number");
  });
});
