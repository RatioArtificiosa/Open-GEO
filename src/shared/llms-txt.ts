/**
 * The agent-discovery file, as a single source of truth.
 *
 * Kept in code rather than written as a static `.txt` for one reason that has
 * bitten this project before: **a file that nothing imports drifts.** The
 * endpoint, the homepage `<link>`, and the test all read this module, so a link
 * that dies is a failing test rather than a 404 an agent finds at runtime.
 *
 * Verified against the llms.txt spec **v2** (2026-08-10):
 *
 * - The only *required* section is the H1 project name. Everything else is
 *   optional, and a file that lists pages that 404 is worse than a short one.
 * - v2 added `rel="alternate" type="text/markdown"` for a page's markdown
 *   version and `rel="describedby"` for the llms.txt covering it. Emitted as
 *   real HTTP `Link:` headers below, which is what the spec allows and what a
 *   crawler reads without parsing HTML.
 * - v2 allows both `page.html.md` (v1) and `page.md` (v2).
 * - The spec states **no byte or token limit** — only that the file "stays
 *   small enough to fit in context". `LLMS_TXT_BUDGET_BYTES` below is therefore
 *   *our* ceiling for a practical reason (an agent reads this whole file before
 *   deciding what to fetch), and it is labelled as ours rather than attributed
 *   to the spec.
 * - The `## Optional` section's mechanical semantics, and the `llms_txt2ctx`
 *   tool that gave them meaning, were **removed in v2**. The convention survives;
 *   the tool does not.
 */

const ORIGIN = "https://opengeo.so";

/** Our own ceiling, not the spec's: the whole file is read before any fetch. */
export const LLMS_TXT_BUDGET_BYTES = 8_000;

type Entry = {
  title: string;
  /** Path relative to the origin. */
  path: string;
  /** One line saying what an agent gets. Leads with the verb. */
  note: string;
};

/**
 * What an agent can do here, grouped the way the spec's H2 sections want:
 * a group is a capability, not a page type.
 */
const SECTIONS: Array<{ heading: string; entries: Entry[] }> = [
  {
    heading: "Start here",
    entries: [
      {
        title: "OpenGeo home",
        path: "/",
        note: "What the product does and who it is for, in one screen.",
      },
      {
        title: "Why your traffic charts break on 1 November 2026",
        path: "/blog/etv-model-change",
        note: "The ETV formula change that silently corrupts competitor traffic charts, and the stamp we store against every value.",
      },
    ],
  },
  {
    heading: "Methodology",
    entries: [
      {
        title: "GEO methodology",
        path: "/docs/methodology",
        note: "How mentions, share of voice and the citation gap are measured, and which two numbers must never be added together.",
      },
      {
        title: "DataForSEO gotchas",
        path: "/docs/dataforseo-gotchas",
        note: "The vendor behaviours that silently cost money or corrupt a metric. Read this before building on the API.",
      },
    ],
  },
  {
    heading: "Agent access",
    entries: [
      {
        title: "MCP server",
        path: "/docs/mcp",
        note: "Connect an agent to a project's AI visibility. Tools return per-platform figures, never a blended total.",
      },
      {
        title: "Skills and plugins",
        path: "/docs/agents",
        note: "Installable agent skills for Claude, Codex, Cursor, Gemini CLI and Antigravity.",
      },
    ],
  },
  {
    heading: "Source",
    entries: [
      {
        title: "GitHub repository",
        path: "https://github.com/RatioArtificiosa/Open-GEO",
        note: "The full open-source product, AGPL-3.0.",
      },
    ],
  },
];

/** Render the file. Pure, so the shape can be asserted in a test. */
export function renderLlmsTxt(origin: string = ORIGIN): string {
  const lines: string[] = [
    "# OpenGeo",
    "",
    "> OpenGeo is an AI-visibility platform: it measures whether ChatGPT, Gemini,",
    "> Perplexity and Google AI actually mention your brand, archives those answers,",
    "> and shows the gap between what they retrieve and what they cite. Every",
    "> metric is per platform, and no two are ever added together.",
    "",
  ];

  for (const section of SECTIONS) {
    lines.push(`## ${section.heading}`, "");
    for (const entry of section.entries) {
      const url = entry.path.startsWith("http")
        ? entry.path
        : `${origin}${entry.path}`;
      lines.push(`- [${entry.title}](${url}): ${entry.note}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The v2 `Link:` headers for a page.
 *
 * `alternate` points at that page's markdown version, `describedby` at the
 * llms.txt that covers it. Emitted as headers rather than `<link>` elements so a
 * crawler gets them without parsing HTML, which is the form the spec allows.
 */
export function llmsLinkHeaders(
  markdownPath: string,
  origin: string = ORIGIN,
): Record<string, string> {
  const markdown = markdownPath.startsWith("http")
    ? markdownPath
    : `${origin}${markdownPath}`;
  return {
    "content-type": "text/plain; charset=utf-8",
    link: `<${markdown}>; rel="alternate"; type="text/markdown", <${origin}/llms.txt>; rel="describedby"`,
    // Agents re-fetch this constantly; a cached copy of a stale agent list is
    // worse than a round trip.
    "cache-control": "public, max-age=3600",
  };
}
