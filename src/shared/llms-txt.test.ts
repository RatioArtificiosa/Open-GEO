import { describe, expect, it } from "vitest";
import {
  LLMS_TXT_BUDGET_BYTES,
  llmsLinkHeaders,
  renderLlmsTxt,
} from "./llms-txt";

/**
 * The agent-discovery file.
 *
 * Verified against the llms.txt spec **v2** (2026-08-10), and these tests pin
 * the parts that are easy to get wrong by writing the file from memory:
 *
 * - The H1 project name is the **only** required section.
 * - Sections are H2-delimited lists of `- [name](url): notes`.
 * - v2 added `rel="alternate"` and `rel="describedby"` link relations.
 * - v2 **removed** the `llms_txt2ctx` tool and the mechanical semantics of the
 *   `## Optional` section. A file or comment that references it is stale.
 *
 * The spec states **no byte limit**, so the budget asserted here is explicitly
 * ours and is labelled as such in the source. Inventing a number and calling it
 * the spec's would be a small lie in a file whose entire job is accuracy.
 */

const rendered = renderLlmsTxt();

describe("llms.txt shape", () => {
  it("starts with an H1 project name, the one required section", () => {
    expect(rendered.startsWith("# OpenGeo\n")).toBe(true);
  });

  it("carries a blockquote summary immediately after the title", () => {
    // The summary is what an agent reads before deciding to fetch anything, so
    // it has to say what the product is, not what the page is about.
    const lines = rendered.split("\n");
    expect(lines[2]?.startsWith(">")).toBe(true);
  });

  it("uses H2 sections of markdown links, never a flat list", () => {
    const sections = rendered
      .split("\n")
      .filter((line) => line.startsWith("## "));
    expect(sections.length).toBeGreaterThan(1);
    for (const line of rendered.split("\n")) {
      if (!line.startsWith("- ")) continue;
      // The spec's list form is `- [name](url): notes`. An entry missing the
      // colon is parsed as a bare link and loses its explanation.
      expect(line, `entry without a note: ${line}`).toMatch(
        /^- \[.+\]\(.+\): .+/,
      );
    }
  });

  it("fits a budget an agent will actually read in full", () => {
    // The whole point of the file is that it is read before anything is
    // fetched, so its size is the cost of the entry point.
    expect(rendered.length).toBeLessThanOrEqual(LLMS_TXT_BUDGET_BYTES);
  });

  it("ends with a single trailing newline, not a blank line", () => {
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false);
  });

  it("uses absolute URLs, because a relative one has no site to resolve against", () => {
    for (const line of rendered.split("\n")) {
      if (!line.startsWith("- [")) continue;
      const url = /\]\((.+?)\)/.exec(line)?.[1] ?? "";
      expect(url, `relative URL: ${line}`).toMatch(/^https?:\/\//);
    }
  });

  it("does not reference the expansion tool v2 removed", () => {
    // `llms_txt2ctx` and the mechanical `## Optional` semantics were both
    // dropped in v2. A pointer to it sends an agent to a tool that no longer
    // exists.
    expect(rendered).not.toMatch(/llms_txt2ctx/i);
  });
});

describe("llms.txt content", () => {
  it("says the two demand figures must not be added together", () => {
    // This is the product's central claim, and the reason a `.ai`-style or
    // blended summary would be worse than nothing. If an agent reads only the
    // llms.txt, this sentence is what stops it reporting a meaningless total.
    expect(rendered).toMatch(
      /never added together|not be added|no two are ever/i,
    );
  });

  it("points at the MCP server, which is the agent's way in", () => {
    expect(rendered).toMatch(/\/docs\/mcp/);
  });

  it("points at the open-source repository", () => {
    expect(rendered).toMatch(/github\.com\/RatioArtificiosa\/Open-GEO/);
  });

  it("lists the vendor gotchas, because building on the API without them costs money", () => {
    expect(rendered).toMatch(/dataforseo-gotchas/i);
  });
});

describe("v2 link headers", () => {
  it("declares both link relations the spec defines", () => {
    const headers = llmsLinkHeaders("/index.md", "https://opengeo.so");
    // `alternate` → the page's markdown version; `describedby` → the llms.txt
    // covering it. Emitted as headers, which the spec allows and a crawler reads
    // without parsing HTML.
    expect(headers.link).toMatch(/rel="alternate"/);
    expect(headers.link).toMatch(/type="text\/markdown"/);
    expect(headers.link).toMatch(/rel="describedby"/);
    expect(headers.link).toContain("https://opengeo.so/llms.txt");
  });

  it("does not double-prefix an absolute markdown URL", () => {
    const headers = llmsLinkHeaders(
      "https://cdn.example/index.md",
      "https://opengeo.so",
    );
    expect(headers.link).toContain("https://cdn.example/index.md");
    expect(headers.link).not.toContain("https://opengeo.sohttps://");
  });

  it("serves plain text, so a crawler does not have to guess", () => {
    expect(llmsLinkHeaders("/index.md")["content-type"]).toMatch(/text\/plain/);
  });

  it("allows revalidation, because a cached agent list is worse than a round trip", () => {
    expect(llmsLinkHeaders("/index.md")["cache-control"]).toMatch(/max-age/);
  });
});

describe("origin handling", () => {
  it("lets a staging or self-hosted deployment render its own origin", () => {
    // Self-hosted installs serve the same route on their own domain, and a
    // hard-coded production origin would send their agents to the hosted site.
    const selfHosted = renderLlmsTxt("https://geo.internal.example");
    expect(selfHosted).toContain("https://geo.internal.example/docs/mcp");
    expect(selfHosted).not.toContain("https://opengeo.so/docs/mcp");
  });
});
