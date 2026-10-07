import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  // DEMO_MODE is read before auth; undefined keeps demo mode off.
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import { fetchWhoisOverview } from "@/server/lib/dataforseo/whois";
import { requestBody, requestUrl } from "./test-support";

function envelope(items: unknown[]) {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        path: ["v3", "domain_analytics", "whois"],
        cost: 0.1224,
        result: [{ items_count: items.length, items }],
      },
    ],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(mock: ReturnType<typeof vi.fn<typeof fetch>>): unknown[] {
  // One call, narrowed once. Calling `requestBody` on both sides of a ternary means TypeScript
  // narrows the first call and not the second, so `JSON.parse` is handed an object.
  const raw: unknown = requestBody(mock);
  if (typeof raw !== "string") return Array.isArray(raw) ? raw : [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  // A fresh Response per call: a Response body can only be read once.
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWhoisOverview", () => {
  it("posts to domain_analytics/whois/overview/live, not under backlinks", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope([])));

    await fetchWhoisOverview({ filters: [["domain", "like", "%example%"]] });

    const url = requestUrl(fetchMock);
    expect(url).toContain("/v3/domain_analytics/whois/overview/live");
    expect(url).not.toContain("backlinks/whois");
  });

  it("refuses an unfiltered call rather than returning the internet's largest domains", async () => {
    await expect(fetchWhoisOverview({})).rejects.toThrow(/at least one filter/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends no order_by, because this endpoint rejects it in every form tried", async () => {
    // Probed: `order_by` as an array and as a comma-delimited string both answer 40501, so the
    // field is unsupported here and the client must not send one. Asserting its absence is the
    // strongest available check — the earlier version of this test asserted a default sort the
    // vendor refuses, which is how an invalid request passed a green suite.
    fetchMock.mockImplementation(async () => Response.json(envelope([])));

    await fetchWhoisOverview({ filters: [["domain", "like", "%example%"]] });

    const body = parseBody(fetchMock);
    const first = body[0];
    expect(isPlainObject(first) ? Object.hasOwn(first, "order_by") : true).toBe(
      false,
    );
  });

  it("keeps registered:false and a null registrar as they are, because each carries meaning", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        envelope([
          { domain: "expired.example", registered: false, registrar: null },
          {
            domain: "live.example",
            registered: true,
            registrar: "Example Registrar",
          },
        ]),
      ),
    );

    const rows = await fetchWhoisOverview({
      filters: [["domain", "like", "%example%"]],
    });
    expect(rows.data[0]?.registered).toBe(false);
    expect(rows.data[0]?.registrar).toBeNull();
    expect(rows.data[1]?.registrar).toBe("Example Registrar");
  });
  it("reads the vendor's real date field names, so an expiry cannot silently read as unknown", async () => {
    // The regression guard for a real defect: `created`, `expired` and `updated` were invented, and
    // because they were optional every row parsed cleanly with no dates at all. A test that only
    // asserted the fields present in a fixture could not have caught that - so this asserts a field
    // the vendor actually sends, by its real name.
    fetchMock.mockImplementation(async () =>
      Response.json(
        envelope([
          {
            domain: "expiring.example",
            registered: true,
            created_datetime: "2019-04-02 00:00:00 +00:00",
            expiration_datetime: "2026-04-02 00:00:00 +00:00",
            updated_datetime: "2025-11-01 00:00:00 +00:00",
            tld: "com",
            epp_status_codes: ["client transfer prohibited"],
          },
        ]),
      ),
    );

    const rows = await fetchWhoisOverview({
      filters: [["domain", "like", "%example%"]],
    });

    expect(rows.data[0]?.expiration_datetime).toBe(
      "2026-04-02 00:00:00 +00:00",
    );
    expect(rows.data[0]?.tld).toBe("com");
  });
});
