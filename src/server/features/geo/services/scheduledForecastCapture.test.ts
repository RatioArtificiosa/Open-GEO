/**
 * `runDueForecastSnapshots` — the nightly forecast sweep.
 *
 * ## Why this file exists at all, and why it is a unit test rather than a database one
 *
 * The sweep's job is arithmetic over what the archive already holds, so the
 * interesting failures are all **shapes of input**, not SQL: a series with no
 * denominator, a target with no citation window, a project whose audit never ran, a
 * platform that returns no retrievals at all. Each of those is a branch that either
 * stores a refusal or invents a number, and a seeded-SQLite suite cannot reach most
 * of them — it can only reach the shape it seeds.
 *
 * So every collaborator is injected, and the assertions are about what was written:
 * **how many rows, of which kind, and what they say when the engine declined.**
 *
 * Two of these tests exist because the alternative is a silent, permanent, and
 * completely invisible failure mode: a sweep that writes one row per platform per
 * brand would store another brand's visibility under this brand's name, and a sweep
 * that dropped a declining engine would make "we cannot forecast yet" read as "the
 * job did not run".
 */
import { describe, expect, it, vi } from "vitest";

import {
  FORECAST_KINDS,
  FORECAST_MODEL_VERSION,
  type ForecastSnapshotRow,
} from "@/server/features/geo/services/forecastSnapshot";
import { runDueForecastSnapshots } from "./scheduledForecastCapture";

import type { readForecastInput } from "./visibilityForecastReads";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

/** A moment comfortably inside a night, and a whole number of days from the horizon. */
const NOW = new Date("2026-10-14T03:00:00.000Z");

/** The rows the sweep wrote, captured in order. */
type Written = ForecastSnapshotRow[];

/**
 * A stored series the reader can hand back.
 *
 * Twelve weekly observations with a denominator: the floor `forecastVisibility`
 * needs before it reports a direction, so a test that wants a *measured* forecast
 * gets one and a test that wants a *refusal* sets `withDenominator` to false.
 *
 * The dates are **real ISO days, one per week**, because `forecastVisibility`
 * buckets by `weekStartOf(row.date)` and a label it cannot parse collapses the whole
 * series into one week — which is a direction refusal, not a forecast. The first
 * draft of this fixture used `2026-W01`-style labels and every "measured" case was
 * silently testing the refusal path instead.
 */
function observations(input: {
  platform: string;
  rate: number;
  weeks?: number;
  withDenominator?: boolean;
}): Awaited<ReturnType<typeof readForecastInput>> {
  const weeks = input.weeks ?? 12;
  const withDenominator = input.withDenominator ?? true;
  // Oldest first, on Mondays, ending the week before the night the sweep runs.
  const start = Date.parse("2026-07-20T00:00:00Z");
  const rows = Array.from({ length: weeks }, (_, index) => ({
    snapshotId: `snap-${index}`,
    startedAt: new Date(start + index * 7 * 86_400_000).toISOString(),
    platform: input.platform,
    promptsAsked: withDenominator ? 40 : null,
    // A climb of half a point a week, so the weekly slope is positive and large
    // enough to clear the floor without being absurd.
    mentions: withDenominator
      ? Math.min(40, Math.round(40 * (input.rate + 0.005 * index)))
      : 7,
    date: new Date(start + index * 7 * 86_400_000).toISOString(),
  }));

  return {
    domain: "acme.com",
    platform: input.platform,
    observations: rows,
    skipped: { unknownDenominator: 0, noText: 0, noAnswers: 0 },
    windowed: { considered: weeks, totalRunsInProject: weeks },
    note: null,
  };
}

/** The five injections, wired to one in-memory night. */
function harness(input?: {
  targets?: Array<{
    projectId: string;
    targetId: string;
    domain: string;
    platforms: string[];
  }>;
  readiness?: "unknown" | "complete" | "fixes-outstanding";
  forecast?: Awaited<ReturnType<typeof readForecastInput>>;
  citations?: { retrievals: number; citations: number };
}) {
  const written: Written = [];
  const targets = input?.targets ?? [
    {
      projectId: "proj-1",
      targetId: "target-1",
      domain: "acme.com",
      platforms: ["chat_gpt"],
    },
  ];

  return {
    written,
    run: () =>
      runDueForecastSnapshots({
        now: NOW,
        limitProjects: 50,
        fetchTargets: async () => targets,
        fetchReadiness: async () => input?.readiness ?? "complete",
        readForecast: async (args) =>
          input?.forecast ??
          observations({ platform: args.platform, rate: 0.3 }),
        countCitations: async () =>
          input?.citations ?? { retrievals: 40, citations: 12 },
        storeSnapshot: async (row) => {
          written.push(row);
        },
      }),
  };
}

function kindsOf(rows: Written): string[] {
  return rows.map((row) => row.kind);
}

describe("runDueForecastSnapshots: what it writes", () => {
  it("writes an anchor and a projection for every platform, and a win rate for the target", async () => {
    const { written, run } = harness();
    const report = await run();

    expect(report.anchorsStored).toBe(1);
    expect(report.pacesStored).toBe(1);
    expect(report.citationWinsStored).toBe(1);
    expect(kindsOf(written)).toEqual([
      FORECAST_KINDS.visibilityForecast,
      FORECAST_KINDS.visibilityPace,
      FORECAST_KINDS.citationWin,
    ]);
  });

  it("keeps one night's rows on one date, and one project's rows on its own id", async () => {
    const { written, run } = harness();
    await run();

    for (const row of written) {
      expect(row.issuedOn).toBe("2026-10-14");
      expect(row.modelVersion).toBe(FORECAST_MODEL_VERSION);
      expect(row.projectId).toBe("proj-1");
    }
  });

  it("names the pace row by the platform and the win row by the domain", async () => {
    const { written, run } = harness();
    await run();

    const pace = written.find(
      (row) => row.kind === FORECAST_KINDS.visibilityPace,
    );
    const win = written.find((row) => row.kind === FORECAST_KINDS.citationWin);
    expect(pace?.subject).toBe("chat_gpt");
    expect(win?.subject).toBe("acme.com");
  });

  it("spreads the platforms rather than collapsing them into one row", async () => {
    // Platform is part of the key everywhere else in the GEO schema, and a sweep
    // that averaged or overwrote would report one platform's visibility as
    // another's — the same class of bug `readForecastInput` documents at length.
    const { written, run } = harness({
      targets: [
        {
          projectId: "proj-1",
          targetId: "target-1",
          domain: "acme.com",
          platforms: ["chat_gpt", "google_ai_overviews", "perplexity"],
        },
      ],
    });
    await run();

    expect(
      kindsOf(written).filter((k) => k === FORECAST_KINDS.visibilityPace),
    ).toHaveLength(3);
    expect(new Set(written.map((row) => row.subject))).toEqual(
      new Set(["chat_gpt", "google_ai_overviews", "perplexity", "acme.com"]),
    );
  });

  it("keeps three brands in one project as three independent targets", async () => {
    const { written, run } = harness({
      targets: [
        {
          projectId: "proj-1",
          targetId: "t1",
          domain: "acme.com",
          platforms: ["chat_gpt"],
        },
        {
          projectId: "proj-1",
          targetId: "t2",
          domain: "acme.co.uk",
          platforms: ["chat_gpt"],
        },
        {
          projectId: "proj-1",
          targetId: "t3",
          domain: "acme.io",
          platforms: ["chat_gpt"],
        },
      ],
    });
    const report = await run();

    expect(report.targetsVisited).toBe(3);
    expect(report.citationWinsStored).toBe(3);
    expect(
      new Set(
        written
          .filter((r) => r.kind === FORECAST_KINDS.citationWin)
          .map((r) => r.subject),
      ).size,
    ).toBe(3);
  });
});

describe("runDueForecastSnapshots: a declining engine is stored, not dropped", () => {
  it("writes the row with nulls when the archive has no denominator", async () => {
    // A live run can never know how many prompts the vendor asked, so every
    // observation has `promptsAsked: null`. The forecast declines. The row must
    // still exist, because "we cannot forecast this" is the sentence a reader
    // needs and a missing row would read as a job that did not run.
    const { written, run } = harness({
      forecast: observations({
        platform: "chat_gpt",
        rate: 0.3,
        withDenominator: false,
      }),
    });
    const report = await run();

    expect(report.anchorsStored).toBe(1);
    expect(report.declined).toBeGreaterThan(0);
    const anchor = written.find(
      (row) => row.kind === FORECAST_KINDS.visibilityForecast,
    );
    expect(anchor?.shareBp).toBeNull();
    expect(anchor?.lowBp).toBeNull();
    // The denominator is zero and *stated as zero*: 40 prompts were never asked, so
    // there is nothing to pretend rested on.
    expect(anchor?.basedOn).toBe(0);
  });

  it("stores the note beside the numbers, so a reader learns what the row was allowed to know", async () => {
    const { written, run } = harness({
      forecast: {
        ...observations({ platform: "chat_gpt", rate: 0.3 }),
        note: "Forecasted from 9 of 24 runs, and 15 older runs were not read.",
      },
    });
    await run();

    const anchor = written.find(
      (row) => row.kind === FORECAST_KINDS.visibilityForecast,
    );
    expect(anchor?.note).toContain("15 older runs were not read");
  });

  it("writes no win row at all when there are no retrievals, rather than a 0% rate", async () => {
    // Zero citations out of zero retrievals is not a 0% win rate. It is "we never
    // looked", and the module that would say otherwise is exactly the one
    // `citationWinProbability` refuses.
    const { written, run } = harness({
      citations: { retrievals: 0, citations: 0 },
    });
    const report = await run();

    expect(report.citationWinsStored).toBe(0);
    expect(written.some((row) => row.kind === FORECAST_KINDS.citationWin)).toBe(
      false,
    );
  });

  it("quotes the low end of the interval when the audit has outstanding fixes", async () => {
    const { written, run } = harness({
      readiness: "fixes-outstanding",
      citations: { retrievals: 40, citations: 12 },
    });
    await run();

    const win = written.find((row) => row.kind === FORECAST_KINDS.citationWin);
    // 12/40 = 30%; the Wilson low end is well below that, and it is what gets
    // stored because readiness bounds the estimate and never inflates it.
    expect(win?.shareBp).not.toBeNull();
    expect(win?.nowBp).toBe(3000);
    expect(win?.lowBp ?? 0).toBeLessThan(3000);
    expect(win?.note).toContain("readiness outstanding");
  });

  it("quotes the point estimate when the audit completed", async () => {
    const { written, run } = harness({
      readiness: "complete",
      citations: { retrievals: 40, citations: 12 },
    });
    await run();

    const win = written.find((row) => row.kind === FORECAST_KINDS.citationWin);
    expect(win?.shareBp).toBe(3000);
    expect(win?.nowBp).toBe(3000);
  });

  it("treats an unknown audit as unknown, and says so rather than guessing", async () => {
    const { written, run } = harness({
      readiness: "unknown",
      citations: { retrievals: 40, citations: 12 },
    });
    await run();

    const win = written.find((row) => row.kind === FORECAST_KINDS.citationWin);
    expect(win?.shareBp).toBe(3000);
    expect(win?.note).toContain("readiness unknown");
  });
});

describe("runDueForecastSnapshots: fault isolation", () => {
  it("keeps sweeping after one target throws, and names it in the errors", async () => {
    // One brand's failure must not stop the other two, for the reason every nightly
    // capture gives: a failure here is a missing *evidence row*, and the archive
    // already holds the data to retry with.
    let calls = 0;
    const report = await runDueForecastSnapshots({
      now: NOW,
      fetchTargets: async () => [
        {
          projectId: "proj-1",
          targetId: "t1",
          domain: "acme.com",
          platforms: ["chat_gpt"],
        },
        {
          projectId: "proj-1",
          targetId: "t2",
          domain: "acme.co.uk",
          platforms: ["chat_gpt"],
        },
      ],
      fetchReadiness: async () => "complete",
      readForecast: async (args) => {
        calls += 1;
        if (calls === 1) throw new Error("vendor payload unreadable");
        return observations({ platform: args.platform, rate: 0.3 });
      },
      countCitations: async () => ({ retrievals: 40, citations: 12 }),
      storeSnapshot: async () => {},
    });

    expect(report.targetsVisited).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("acme.com");
    expect(report.errors[0]).toContain("vendor payload unreadable");
    // The second brand still produced its rows, which is the whole point.
    expect(report.anchorsStored).toBe(1);
  });

  it("reports a readiness failure as an error rather than silently as unknown", async () => {
    const { run } = harness();
    void run;

    const report = await runDueForecastSnapshots({
      now: NOW,
      fetchTargets: async () => [
        {
          projectId: "proj-1",
          targetId: "t1",
          domain: "acme.com",
          platforms: ["chat_gpt"],
        },
      ],
      // A readiness read that fails is *unknown*, not a penalty — but it must be
      // visible, or a broken audit service would show up as quietly optimistic
      // forecasts instead of as an error somebody can act on.
      fetchReadiness: async () => {
        throw new Error("audit database unavailable");
      },
      readForecast: async (args) =>
        observations({ platform: args.platform, rate: 0.3 }),
      countCitations: async () => ({ retrievals: 40, citations: 12 }),
      storeSnapshot: async () => {},
    });

    expect(report.errors[0]).toContain("readiness unreadable");
    // And the forecast still runs, on the point estimate, because unknown is the
    // one readiness state that changes nothing.
    expect(report.anchorsStored).toBe(1);
  });

  it("names the targets the sweep limit left behind", async () => {
    const report = await runDueForecastSnapshots({
      now: NOW,
      limitProjects: 1,
      fetchTargets: async () => [
        {
          projectId: "p1",
          targetId: "t1",
          domain: "a.com",
          platforms: ["chat_gpt"],
        },
        {
          projectId: "p2",
          targetId: "t2",
          domain: "b.com",
          platforms: ["chat_gpt"],
        },
      ],
      fetchReadiness: async () => "complete",
      readForecast: async (args) =>
        observations({ platform: args.platform, rate: 0.3 }),
      countCitations: async () => ({ retrievals: 40, citations: 12 }),
      storeSnapshot: async () => {},
    });

    expect(report.skippedForLimit).toBe(1);
    expect(report.targetsVisited).toBe(1);
  });

  it("reports an empty night as visited nothing, not as a failure", async () => {
    const report = await runDueForecastSnapshots({
      now: NOW,
      fetchTargets: async () => [],
      fetchReadiness: async () => "complete",
      readForecast: async (args) =>
        observations({ platform: args.platform, rate: 0.3 }),
      countCitations: async () => ({ retrievals: 40, citations: 12 }),
      storeSnapshot: async () => {},
    });

    expect(report.projectsVisited).toBe(0);
    expect(report.anchorsStored).toBe(0);
    expect(report.errors).toEqual([]);
  });
});

describe("runDueForecastSnapshots: the projection it stores is the one the sentence names", () => {
  it("carries the pace module's own projection and band", async () => {
    const { written, run } = harness({
      forecast: observations({
        platform: "chat_gpt",
        rate: 0.1,
        withDenominator: true,
      }),
      citations: { retrievals: 0, citations: 0 },
    });
    await run();

    const pace = written.find(
      (row) => row.kind === FORECAST_KINDS.visibilityPace,
    );
    expect(pace?.horizonDays).toBe(90);
    // Rising series: the projection is above the current share, and it is capped at
    // "every prompt measured" by the module that produced it.
    expect(pace?.shareBp).not.toBeNull();
    expect(pace?.shareBp ?? 0).toBeGreaterThan(0);
    expect(pace?.perWeekBp).toBeGreaterThan(0);
  });

  it("stores a falling pace as a negative weekly change, not as a clamp at zero", async () => {
    // A falling share is a real and reportable state. Clamping it would turn a
    // decline into a plateau, which is the direction that flatters.
    const falling = observations({ platform: "chat_gpt", rate: 0.1 });
    falling.observations = falling.observations.map((row, index) => ({
      ...row,
      mentions: 40 - index * 2,
    }));

    const { written, run } = harness({
      forecast: falling,
      citations: { retrievals: 0, citations: 0 },
    });
    await run();

    const pace = written.find(
      (row) => row.kind === FORECAST_KINDS.visibilityPace,
    );
    expect(pace?.perWeekBp).toBeLessThan(0);
  });
});
