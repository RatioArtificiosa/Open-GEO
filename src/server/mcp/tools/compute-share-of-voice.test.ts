import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as KeywordLocations from "@/shared/keyword-locations";

/**
 * The share-of-voice tool.
 *
 * It exists because the `geo-audit` skill tells an agent to call
 * `compute_share_of_voice(...)`, and before this there was no such tool — the
 * audit the skill calls its highest-value output could not start.
 *
 * The tests are mostly about the two claims the tool makes to the agent reading
 * its output:
 *
 * 1. **It does not spend credits unless told.** The default is a dry run,
 *    because this fans out to billable vendor calls and spending the user's
 *    credits should be a decision, not a side effect of asking a question.
 * 2. **It returns no demand figure at all.** Mentions are comparable across
 *    platforms and are summed; demand is not, so the honest move is to omit the
 *    metric rather than offer it with a caveat attached.
 */

const getBrandLookup = vi.fn();
const resolveLabsMarket = vi.fn();
const assertLocation = vi.fn();
const assertLanguage = vi.fn();

/**
 * The project context, hoisted because the mock factory below runs before module
 * initialisation. A fixture declared normally would be an uninitialised binding
 * at the moment the factory executes, and that surfaces as an unrelated
 * "cannot read property of undefined" rather than as the ordering bug it is.
 */
const { PROJECT_CONTEXT } = vi.hoisted(() => ({
  PROJECT_CONTEXT: {
    auth: {
      userId: "u1",
      userEmail: "a@example.com",
      organizationId: "org_1",
      role: "owner",
      // `as const` so `orgScope` stays the literal union `"user" | "pinned"`.
      // Widened to `string` inside an object literal, it does not satisfy
      // `ToolAuthContext` — a fixture that does not typecheck is not a shortcut,
      // it is a second thing to fix.
      orgScope: "pinned" as const,
      clientId: null,
      scopes: ["mcp"],
      clientLabel: "Test",
      baseUrl: "https://app.opengeo.so",
    },
    baseUrl: "https://app.opengeo.so",
    billing: {
      userId: "u1",
      userEmail: "a@example.com",
      organizationId: "org_1",
      projectId: "p1",
    },
    project: {
      id: "p1",
      name: "Acme",
      domain: null,
      locationCode: 2840,
      languageCode: "en",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/ai-search/services/brandLookup", () => ({
  getBrandLookup,
}));

// `importActual` rather than a bare replacement: `@/shared/keyword-locations` is
// imported by other modules in this graph, and a partial mock throws on the
// first missing export rather than failing on the assertion you care about.
vi.mock("@/shared/keyword-locations", async () => {
  const actual = await vi.importActual<typeof KeywordLocations>(
    "@/shared/keyword-locations",
  );
  return { ...actual, resolveLabsMarket };
});
vi.mock("@/server/lib/market", () => ({
  assertLabsLocationCode: assertLocation,
  assertLanguageForLocation: assertLanguage,
}));

/**
 * A faithful stand-in for `withMcpProjectAuth`.
 *
 * The real wrapper takes a `ToolContext`, calls `requireProjectAccess`, and hands
 * the resulting project context to the handler. An *identity* mock would leave
 * the exported handler typed against `ToolContext` and pass it the wrong object —
 * so the signature and the unwrapping are both reproduced, with the membership
 * lookup replaced by the fixture.
 */
vi.mock("@/server/mcp/project-auth", () => ({
  withMcpProjectAuth:
    (
      handler: (
        args: Record<string, unknown>,
        context: unknown,
      ) => Promise<unknown>,
    ) =>
    (args: Record<string, unknown>) =>
      handler(args, PROJECT_CONTEXT),
  requireProjectAccess: vi.fn(async () => PROJECT_CONTEXT),
}));

const { computeShareOfVoiceTool } =
  await import("@/server/mcp/tools/compute-share-of-voice");

type SoVArgs = {
  projectId: string;
  target: string;
  competitors: string[];
  locationCode?: number;
  languageCode?: string;
  dry_run?: boolean;
};

type ToolResult = {
  // `CallToolResult` content is a union including image and resource parts, so
  // this cannot be narrowed to text. The helper below reads only the text ones.
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

/**
 * Invoke the tool the way the server does.
 *
 * The exported `handler` is the *wrapper*, so it takes `(args, toolContext)` and
 * the `ToolContext` must typecheck even though the mocked wrapper discards it and
 * supplies the project context itself. Passing the auth block is the honest
 * option: the real wrapper would use it to authorize.
 */
async function call(data: SoVArgs): Promise<ToolResult> {
  return computeShareOfVoiceTool.handler(data, {
    auth: PROJECT_CONTEXT.auth,
  });
}

function textOf(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content
    .filter((part): part is { type: string; text: string } =>
      Boolean(part.text),
    )
    .map((part) => part.text)
    .join("\n");
}

beforeEach(() => {
  getBrandLookup.mockReset();
  resolveLabsMarket.mockReset().mockReturnValue({
    locationCode: 2840,
    languageCode: "en",
  });
  assertLocation.mockReset();
  assertLanguage.mockReset();
});

describe("compute_share_of_voice", () => {
  it("does not call the vendor by default", async () => {
    // This fans out to billable DataForSEO calls. Spending the user's credits
    // has to be a decision they make, not a side effect of asking a question.
    const result = await call({
      projectId: "p1",
      target: "acme.com",
      competitors: ["rival.com"],
    });
    expect(getBrandLookup).not.toHaveBeenCalled();
    expect(textOf(result)).toMatch(/dry run/i);
    expect(textOf(result)).toMatch(/no credits were spent/i);
  });

  it("names the competitors and the market in the dry run", async () => {
    // A dry run that does not say what it *would* do is not a useful dry run.
    const result = await call({
      projectId: "p1",
      target: "acme.com",
      competitors: ["rival.com", "other.com"],
    });
    const text = textOf(result);
    expect(text).toContain("rival.com");
    expect(text).toContain("other.com");
    expect(text).toContain("2840/en");
  });

  it("calls the vendor only when dry_run is explicitly false", async () => {
    getBrandLookup.mockResolvedValue({
      resolvedTarget: "acme.com",
      shareOfVoice: {
        platforms: ["chat_gpt", "google"],
        entries: [
          { label: "acme.com", isTarget: true, mentions: 10, sharePct: 50 },
          { label: "rival.com", isTarget: false, mentions: 10, sharePct: 50 },
        ],
      },
    });
    await call({
      projectId: "p1",
      target: "acme.com",
      competitors: ["rival.com"],
      dry_run: false,
    });
    expect(getBrandLookup).toHaveBeenCalledTimes(1);
  });

  it("reports which platforms were summed", async () => {
    // A leaderboard over summed mentions is only interpretable if the reader
    // knows what the sum covers — and so is not a per-platform figure.
    getBrandLookup.mockResolvedValue({
      resolvedTarget: "acme.com",
      shareOfVoice: {
        platforms: ["chat_gpt"],
        entries: [
          { label: "acme.com", isTarget: true, mentions: 7, sharePct: 70 },
        ],
      },
    });
    const result = await call({
      projectId: "p1",
      target: "acme.com",
      competitors: ["rival.com"],
      dry_run: false,
    });
    expect(textOf(result)).toMatch(/summed across chat_gpt/i);
  });

  it("returns no demand figure at all", async () => {
    // Google's `ai_search_volume` is real search volume; ChatGPT's is a
    // People-Also-Ask model — 12,621,380 against 63,850 for one keyword. A
    // volume field here would be an invitation to add them.
    getBrandLookup.mockResolvedValue({
      resolvedTarget: "acme.com",
      shareOfVoice: {
        platforms: ["chat_gpt", "google"],
        entries: [
          { label: "acme.com", isTarget: true, mentions: 10, sharePct: 100 },
        ],
      },
    });
    const result = await call({
      projectId: "p1",
      target: "acme.com",
      competitors: ["rival.com"],
      dry_run: false,
    });
    const structured: unknown = result.structuredContent;
    const keys =
      typeof structured === "object" && structured !== null
        ? Object.keys(structured)
        : [];
    for (const key of keys) {
      expect(key.toLowerCase(), `unexpected key: ${key}`).not.toMatch(
        /volume/i,
      );
    }
    expect(textOf(result)).toMatch(/must never be added/i);
  });

  it("renders a brand with no data as unknown rather than zero", async () => {
    // Null and zero are different facts. Rendering no-data as 0 drops the brand
    // from the leaderboard the user paid to compare it on.
    getBrandLookup.mockResolvedValue({
      resolvedTarget: "acme.com",
      shareOfVoice: {
        platforms: ["chat_gpt"],
        entries: [
          { label: "acme.com", isTarget: true, mentions: 10, sharePct: 100 },
          {
            label: "ghost.com",
            isTarget: false,
            mentions: null,
            sharePct: null,
          },
        ],
      },
    });
    const result = await call({
      projectId: "p1",
      target: "acme.com",
      competitors: ["ghost.com"],
      dry_run: false,
    });
    expect(textOf(result)).toMatch(/ghost\.com: no data \(share unknown\)/);
  });

  it("explains an empty result rather than showing a bare empty list", async () => {
    // An empty leaderboard with no explanation reads as "you have no share",
    // which is a finding. It usually means the calls failed.
    getBrandLookup.mockResolvedValue({
      resolvedTarget: "acme.com",
      shareOfVoice: null,
    });
    const result = await call({
      projectId: "p1",
      target: "acme.com",
      competitors: ["rival.com"],
      dry_run: false,
    });
    expect(textOf(result)).toMatch(/not a zero share/i);
  });

  it("is not read-only, because it spends credits", async () => {
    // A tool an agent treats as a free read that quietly spends the user's
    // money is the worst annotation to get wrong.
    expect(computeShareOfVoiceTool.config.annotations.readOnlyHint).toBe(false);
    expect(computeShareOfVoiceTool.config.annotations.destructiveHint).toBe(
      false,
    );
  });

  it("validates the market before spending anything", async () => {
    // The assertions run on the dry-run path too, so an invalid market is caught
    // before the caller flips `dry_run` and pays for the attempt.
    await call({
      projectId: "p1",
      target: "acme.com",
      competitors: ["rival.com"],
    });
    expect(assertLocation).toHaveBeenCalledWith(2840);
    expect(assertLanguage).toHaveBeenCalledWith(2840, "en");
  });
});
