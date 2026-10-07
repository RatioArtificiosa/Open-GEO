import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  // DEMO_MODE is read before auth; undefined keeps demo mode off.
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import {
  domainTechnologiesRowSchema,
  fetchDomainTechnologies,
  sliceByTechnology,
  technologyNames,
  type DomainTechnologiesRow,
} from "@/server/lib/dataforseo/technologies";
import { requestBody, requestUrl } from "./test-support";

function envelope(items: unknown[]) {
  return {
    status_code: 20000,
    tasks: [
      {
        status_code: 20000,
        path: ["v3", "domain_analytics", "technologies"],
        cost: 0.012,
        result: [{ items_count: items.length, items }],
      },
    ],
  };
}

// One call, narrowed once: calling requestBody on both sides of a ternary means TypeScript narrows
// the first call and not the second.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(
  mock: ReturnType<typeof vi.fn<typeof fetch>>,
): Array<Record<string, unknown>> {
  const raw: unknown = requestBody(mock);
  if (typeof raw !== "string")
    return Array.isArray(raw) ? raw.filter(isPlainObject) : [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter(isPlainObject) : [];
}

function row(
  partial: Partial<DomainTechnologiesRow> & { domain: string },
): DomainTechnologiesRow {
  return domainTechnologiesRowSchema.parse(partial);
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

describe("fetchDomainTechnologies", () => {
  it("posts to domain_analytics/technologies/domain_technologies/live", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope([])));

    await fetchDomainTechnologies({ target: "example.com" });

    const url = requestUrl(fetchMock);
    expect(url).toContain(
      "/v3/domain_analytics/technologies/domain_technologies/live",
    );
    expect(url).not.toContain("/technologies/technologies/live");
  });

  it("sends target as a plain string, not the object array llm_mentions uses", async () => {
    fetchMock.mockImplementation(async () => Response.json(envelope([])));

    await fetchDomainTechnologies({ target: "example.com" });

    expect(parseBody(fetchMock)[0]?.target).toBe("example.com");
  });

  it("refuses an empty target rather than spending a request on it", async () => {
    await expect(fetchDomainTechnologies({ target: "   " })).rejects.toThrow(
      /target/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("technologyNames", () => {
  it("flattens the vendor's category buckets into one lowercase list", () => {
    const names = technologyNames(
      row({
        domain: "shop.example",
        technologies: {
          ecommerce: [{ name: "Shopify" }],
          marketing: [{ name: "Klaviyo" }, { name: "Google Analytics" }],
        },
      }),
    );
    // No sort: the repo bans in-place `.sort()` and the target has no `toSorted`. The order is
    // deterministic from the buckets above, so asserting it exactly is stronger anyway.
    expect(names).toEqual(["shopify", "klaviyo", "google analytics"]);
  });

  it("returns an empty list when the vendor sends no technologies, rather than failing", () => {
    expect(
      technologyNames(row({ domain: "bare.example", technologies: null })),
    ).toEqual([]);
  });
});

describe("sliceByTechnology", () => {
  const shopifyOnly = row({
    domain: "shopify-only.example",
    technologies: { ecommerce: [{ name: "Shopify" }] },
  });
  const shopifyWithKlaviyo = row({
    domain: "shopify-klaviyo.example",
    technologies: {
      ecommerce: [{ name: "Shopify" }],
      marketing: [{ name: "Klaviyo" }],
    },
  });

  it("requires every name, not just one, because a lead list asks an all-question", () => {
    const sliced = sliceByTechnology([shopifyOnly, shopifyWithKlaviyo], {
      required: ["shopify", "klaviyo"],
    });
    expect(sliced.map((r) => r.domain)).toEqual(["shopify-klaviyo.example"]);
  });

  it("excludes the stack the seller is selling against, so the gap is the prospect list", () => {
    const sliced = sliceByTechnology([shopifyOnly, shopifyWithKlaviyo], {
      required: ["shopify"],
      excluded: ["klaviyo"],
    });
    expect(sliced.map((r) => r.domain)).toEqual(["shopify-only.example"]);
  });

  it("returns everything when no requirement is stated, so an empty call is not a silent no-op", () => {
    expect(sliceByTechnology([shopifyOnly], {}).map((r) => r.domain)).toEqual([
      "shopify-only.example",
    ]);
  });
});

describe("domainTechnologiesRowSchema", () => {
  it("keeps a missing email list as absent rather than inventing an empty one", () => {
    const parsed = row({ domain: "quiet.example" });
    expect(parsed.emails ?? null).toBeNull();
    expect(parsed.domain).toBe("quiet.example");
  });
});
