import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  // DEMO_MODE is read before auth; undefined keeps demo mode off.
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

/**
 * `cloudflare:workers` is not resolvable outside workerd, and the screenshot copier now
 * imports it for R2.
 *
 * **Mocked rather than avoided**, so these tests still exercise the real code path: the copier
 * runs on every call, and a suite that stubbed the whole module out would pass while the
 * wiring was broken. The R2 bucket is a spy, so a screenshot in a fixture *is* copied — and the
 * assertions elsewhere can check that our key came back rather than the vendor's URL.
 *
 * **The spy is typed**, so `mock.calls[0][0]` is the key rather than a length-0 tuple: an
 * untyped `vi.fn(async () => undefined)` records calls with no parameters at all, which is why
 * the first version had to assert its way to an array.
 */
const r2Put = vi.hoisted(() =>
  vi.fn(
    (
      _key: string,
      _body: unknown,
      _options: { customMetadata: Record<string, string> },
    ) => Promise.resolve(undefined),
  ),
);
vi.mock("cloudflare:workers", () => ({ env: { R2: { put: r2Put } } }));

import { DataforseoChargedTaskError } from "@/server/lib/dataforseo/envelope";
import {
  fetchLighthouseResult,
  type LighthouseResultWithScreenshots,
  type StoredScreenshots,
} from "@/server/lib/dataforseo/lighthouse";
import { requestUrl } from "./test-support";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLighthouseResult", () => {
  it("posts to the lighthouse live/json endpoint", async () => {
    // Found by the endpoint-path gate: the other tests here check billing
    // metadata and parse failures, and the URL was asserted nowhere. Lighthouse
    // is billed per audit, so the destination is part of what is being paid for.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        status_message: "Ok.",
        tasks: [
          {
            id: "task-1",
            status_code: 20000,
            status_message: "Ok.",
            path: ["v3", "on_page", "lighthouse", "live", "json"],
            cost: 0.00425,
            result: [],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await fetchLighthouseResult({
      url: "https://example.com",
      strategy: "desktop",
    }).catch(() => {
      // The empty result is not the subject of this test; the URL is.
    });
    expect(requestUrl(fetchMock)).toContain("/v3/on_page/lighthouse/live/json");
  });

  it("copies the vendor screenshot and returns OUR key, never the vendor URL", async () => {
    // **The wiring, not the copier.** `vendorAssetCopy.test.ts` proves the copier's own
    // contract; this proves the client actually calls it on every audit — and that the thing
    // returned to a caller is a key, so there is no field on this path a renderer could put
    // in an `<img src>`.
    const VENDOR_IMAGE =
      "https://api.dataforseo.com/v3/lighthouse/task_get/live/t1/result/final-screenshot.jpg";

    // Two fetches: the billed Lighthouse call, then the copier's download.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          status_code: 20000,
          status_message: "Ok.",
          tasks: [
            {
              id: "task-1",
              status_code: 20000,
              status_message: "Ok.",
              path: ["v3", "on_page", "lighthouse", "live", "json"],
              cost: 0.00425,
              result: [
                {
                  requestedUrl: "https://example.com/",
                  finalUrl: "https://example.com/",
                  lighthouseVersion: "12.2.0",
                  categories: {
                    performance: { score: 0.54, auditRefs: [] },
                    accessibility: { score: 0.9, auditRefs: [] },
                    "best-practices": { score: 0.9, auditRefs: [] },
                    seo: { score: 0.9, auditRefs: [] },
                  },
                  audits: {
                    "final-screenshot": {
                      details: { type: "screenshot", data: VENDOR_IMAGE },
                      score: 1,
                    },
                  },
                },
              ],
            },
          ],
        }),
      )
      .mockResolvedValue(new Response(new Uint8Array(256), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { data } = await fetchLighthouseResult({
      url: "https://example.com",
      strategy: "desktop",
    });

    // **The vendor's URL is nowhere in what comes back.**
    expect(JSON.stringify(data)).not.toContain("dataforseo.com");
    expect(r2Put).toHaveBeenCalledTimes(1);

    // **The stored screenshot is a key, and these two types are what make that structural.**
    // `StoredScreenshots` has **no URL field at all**, so the compile error arrives the day
    // someone adds one; `LighthouseResultWithScreenshots` is the declared return type, which
    // is the thing whose absence made the whole feature invisible to `tsc` in the first
    // place. Both are read here so `knip` can see they are used, and so a future change to
    // either is a **compile error in this line** rather than a surprise in production.
    const shots: StoredScreenshots | undefined = data.screenshots;
    const asDeclared: LighthouseResultWithScreenshots = data;
    expect(shots).toBe(asDeclared.screenshots);
    expect(shots?.["final-screenshot"]?.key).toMatch(/^[0-9a-f]{64}\.bin$/);
    expect(shots?.["final-screenshot"]?.bytes).toBe(256);

    // **Read off the typed spy**, which declares its parameters — an untyped `vi.fn()` records
    // calls with no arguments at all, which is why the first version asserted its way to an
    // array and was rejected for claiming a shape the mock never had.
    expect(r2Put.mock.calls[0][0]).toMatch(
      /^vendor-assets\/[0-9a-f]{64}\.bin$/,
    );
  });

  it("carries billing metadata when parsing fails after a billed success", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        status_message: "Ok.",
        tasks: [
          {
            id: "task-1",
            status_code: 20000,
            status_message: "Ok.",
            path: ["v3", "on_page", "lighthouse", "live", "json"],
            cost: 0.00425,
            result: [
              {
                requestedUrl: "https://example.com/",
                finalUrl: "https://example.com/",
                categories: {},
                audits: {},
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const rejection = fetchLighthouseResult({
      url: "https://example.com/",
      strategy: "mobile",
    });

    await expect(rejection).rejects.toBeInstanceOf(DataforseoChargedTaskError);
    await expect(rejection).rejects.toMatchObject({
      billing: {
        path: ["v3", "on_page", "lighthouse", "live", "json"],
        costUsd: 0.00425,
      },
    });
  });

  it("does not retry an HTTP 5xx (the provider may have charged the task)", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("upstream failure", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLighthouseResult({
        url: "https://example.com/",
        strategy: "mobile",
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
