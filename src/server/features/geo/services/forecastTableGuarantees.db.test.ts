/**
 * The table's own guarantees, against a real database.
 *
 * ## Why `onConflictDoNothing` cannot be tested with a mock
 *
 * A mocked query builder pushes whatever it is told to, so "a second run on the same
 * night is ignored" becomes an assertion that the mock received two calls — which is
 * the *opposite* of the claim. Idempotency lives in the unique index, and the only way
 * to watch it work is to let SQLite enforce it. The same reasoning covers the
 * multi-brand case, which is the one that mattered most: `geo_targets` is one row per
 * `(project, domain, market)` and the patrol runs once per target, so a project
 * monitoring two brands wrote the *same* platform key twice a night before `0065`.
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
  seedAnswers,
  startForecastTestDb,
} from "./forecastDbHarness";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

let harness: Awaited<ReturnType<typeof startForecastTestDb>>;

/** A pace row, with the defaults the sweep writes and only the key fields varied. */
function paceRow(overrides: Partial<ForecastSnapshotRow>): ForecastSnapshotRow {
  return {
    projectId: "proj-1",
    domain: FORECAST_TEST_DOMAIN,
    kind: FORECAST_KINDS.visibilityPace,
    subject: "chat_gpt",
    modelVersion: FORECAST_MODEL_VERSION,
    issuedOn: "2026-07-16",
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
    ...overrides,
  };
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

describe("geo_forecast_snapshots: the guarantees a re-run depends on", () => {
  it("ignores a second write of the same night rather than forking the series", async () => {
    const first = paceRow({});
    await harness.ForecastSnapshotsRepository.insertSnapshot(first);
    // Same key, a different number. An upsert would overwrite the evening's forecast
    // with a value computed minutes later from a slightly different archive, and the
    // row's whole claim is the date it names.
    await harness.ForecastSnapshotsRepository.insertSnapshot({
      ...first,
      shareBp: 9000,
      lowBp: null,
      highBp: null,
      note: "rewritten by a second run",
    });

    const rows = await harness.ForecastSnapshotsRepository.historyFor({
      projectId: "proj-1",
      domain: FORECAST_TEST_DOMAIN,
      kind: FORECAST_KINDS.visibilityPace,
      subject: "chat_gpt",
      modelVersion: FORECAST_MODEL_VERSION,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.shareBp).toBe(4000);
    expect(rows[0]?.note).toBeNull();
  });

  it("keeps two brands in one project on separate rows, and never scores one against the other", async () => {
    // The defect `0065` was written for. Without the domain in the key these two
    // inserts collide and one brand's forecast disappears while the sweep reports
    // having written it; and the reader, which measures a named domain, would read
    // back whichever brand's row survived.
    await seedAnswers(harness.client);
    await harness.ForecastSnapshotsRepository.insertSnapshot(paceRow({}));
    await harness.ForecastSnapshotsRepository.insertSnapshot(
      paceRow({
        domain: "acme.co.uk",
        shareBp: 1000,
        lowBp: 500,
        highBp: 1800,
        perWeekBp: 100,
        nowBp: 800,
      }),
    );

    const rows = await harness.db
      .selectDistinct()
      .from(harness.geoForecastSnapshots);
    // Compared as a set, not as a sorted list: the repo bans `Array#sort()`, and a
    // sorted copy here would only be for the reader's eye.
    expect(new Set(rows.map((row) => row.domain))).toEqual(
      new Set(["acme.co.uk", FORECAST_TEST_DOMAIN]),
    );

    // And the read for one brand returns that brand's numbers.
    const forAcme = await harness.ForecastSnapshotsRepository.historyFor({
      projectId: "proj-1",
      domain: FORECAST_TEST_DOMAIN,
      kind: FORECAST_KINDS.visibilityPace,
      subject: "chat_gpt",
      modelVersion: FORECAST_MODEL_VERSION,
    });
    expect(forAcme).toHaveLength(1);
    expect(forAcme[0]?.shareBp).toBe(4000);
  });

  it("refuses a row that cannot name its brand", async () => {
    await expect(
      harness.ForecastSnapshotsRepository.insertSnapshot(
        paceRow({ domain: "   " }),
      ),
    ).rejects.toThrow(/refuses to store a snapshot with no domain/);
  });
});
