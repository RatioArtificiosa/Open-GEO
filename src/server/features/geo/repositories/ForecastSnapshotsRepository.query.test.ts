import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Values passed to `.values()`, captured so the write can be asserted without a database. */
const written = vi.hoisted(() => [] as Array<Record<string, unknown>>);

// `@/db/schema` must be mocked too, not just `@/db`: the provider-aware barrel imports
// `cloudflare:workers` and cannot load under vitest, so importing it for real fails the file.
vi.mock("@/db/schema", () => ({ geoForecastSnapshots: {} }));

vi.mock("@/db", () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: async () => {
          written.push(values);
        },
      }),
    }),
  },
}));

import { ForecastSnapshotsRepository } from "@/server/features/geo/repositories/ForecastSnapshotsRepository";
import {
  FORECAST_MODEL_VERSION,
  type ForecastSnapshotRow,
} from "@/server/features/geo/services/forecastSnapshot";

const base: ForecastSnapshotRow = {
  projectId: "proj-1",
  kind: "visibility_pace",
  subject: "chat_gpt",
  modelVersion: FORECAST_MODEL_VERSION,
  issuedOn: "2026-10-14",
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
};

beforeEach(() => {
  written.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ForecastSnapshotsRepository.insertSnapshot", () => {
  it("writes the row whole, so a stored snapshot carries its own basis", async () => {
    await ForecastSnapshotsRepository.insertSnapshot(base);
    expect(written[0]?.subject).toBe("chat_gpt");
    expect(written[0]?.horizonDays).toBe(90);
    expect(written[0]?.shareBp).toBe(4000);
    expect(written[0]?.issuedOn).toBe("2026-10-14");
  });

  it("ignores a conflict rather than overwriting, because history is append-only", async () => {
    // The unique key carries the issue date, so a second run on the same night
    // produces the same key. An upsert would let a double-fired cron rewrite the
    // evening's forecast with a value computed minutes later from a slightly
    // different archive — the row's whole claim is the date it names.
    await ForecastSnapshotsRepository.insertSnapshot(base);
    await ForecastSnapshotsRepository.insertSnapshot({
      ...base,
      shareBp: 9000,
    });
    expect(written).toHaveLength(2);
  });

  it("stores a declining engine as nulls rather than as zeroes", async () => {
    await ForecastSnapshotsRepository.insertSnapshot({
      ...base,
      shareBp: null,
      lowBp: null,
      highBp: null,
      perWeekBp: null,
      nowBp: null,
    });
    expect(written[0]?.shareBp).toBeNull();
    expect(written[0]?.nowBp).toBeNull();
    expect(written[0]?.basedOn).toBe(40);
  });

  it("keeps a negative weekly change signed", async () => {
    await ForecastSnapshotsRepository.insertSnapshot({
      ...base,
      perWeekBp: -200,
    });
    expect(written[0]?.perWeekBp).toBe(-200);
  });

  it("refuses a row with no subject, because a row nobody can name cannot be read back", async () => {
    await expect(
      ForecastSnapshotsRepository.insertSnapshot({ ...base, subject: "  " }),
    ).rejects.toThrow(/refuses to store a snapshot with no subject/);
    expect(written).toHaveLength(0);
  });

  it("refuses an unstamped model version before the insert, so the failure names the reason", async () => {
    await expect(
      ForecastSnapshotsRepository.insertSnapshot({
        ...base,
        modelVersion: " ",
      }),
    ).rejects.toThrow(/refuses to store a snapshot with no model version/);
    expect(written).toHaveLength(0);
  });

  it("refuses a negative horizon, which is not a forecast that speaks over less than no days", async () => {
    await expect(
      ForecastSnapshotsRepository.insertSnapshot({ ...base, horizonDays: -1 }),
    ).rejects.toThrow(/refuses a negative horizon/);
    expect(written).toHaveLength(0);
  });

  /**
   * The date guard, and why it is the one this file most needs.
   *
   * Every date-bounded read compares `issued_on` **as a string**, which is correct
   * exactly while every writer stores `YYYY-MM-DD`. A timestamp in this column
   * would not fail loudly — it would sort into the wrong place, so `asOfFor` and
   * the horizon filter in the accuracy reader would both return a different row
   * than the one intended, and nothing would say so.
   */
  describe("the issue date guard", () => {
    it("accepts a real calendar day", async () => {
      await ForecastSnapshotsRepository.insertSnapshot(base);
      expect(written).toHaveLength(1);
    });

    it("refuses a timestamp, because the string comparisons on this column would break", async () => {
      await expect(
        ForecastSnapshotsRepository.insertSnapshot({
          ...base,
          issuedOn: "2026-10-14T03:00:00.000Z",
        }),
      ).rejects.toThrow(
        /every date-bounded read compares this column as a string/,
      );
      expect(written).toHaveLength(0);
    });

    it("refuses a day that does not exist in the calendar", async () => {
      // `2026-13-45` matches the shape of a date and is not one; `Date` normalises
      // it into a different day, so it would sort into the wrong place.
      await expect(
        ForecastSnapshotsRepository.insertSnapshot({
          ...base,
          issuedOn: "2026-13-45",
        }),
      ).rejects.toThrow(/refuses the issue date/);
      expect(written).toHaveLength(0);
    });

    it("refuses a loose spelling like a slash-separated date", async () => {
      await expect(
        ForecastSnapshotsRepository.insertSnapshot({
          ...base,
          issuedOn: "14/10/2026",
        }),
      ).rejects.toThrow(/refuses the issue date/);
      expect(written).toHaveLength(0);
    });
  });
});
