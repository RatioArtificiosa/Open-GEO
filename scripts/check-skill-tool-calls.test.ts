import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkTree,
  extractCallTokens,
  harvestWireTools,
  parseOpenAiYaml,
} from "./check-skill-tool-calls.mjs";

/**
 * The CL-213g gate, and the proof that it bites.
 *
 * Three product skills named tools that do not exist
 * (`geo_search_mentions`, `geo_content_gaps`, `domain_intersection`), and
 * nothing failed because skills are prose: no import to resolve, no type to
 * check. So the test that matters is **"the gate fails on a phantom name and
 * passes when that name is removed"**, run against fixtures plus the live
 * tree. The live-tree assertion is the survey half: it fails the day a new
 * phantom ships, which is the only direction this defect moves.
 */

const WIRE = new Set([
  "get_geo_visibility",
  "get_geo_answer_history",
  "get_domain_keyword_suggestions",
  "generate_content_brief",
]);

describe("extractCallTokens", () => {
  it("reads both call shapes and nothing else", () => {
    const source = [
      "Call `get_geo_visibility(target, platform)` once per platform.",
      "```",
      "get_geo_answer_history(domain, platform, prompt, limit)",
      "```",
      "Keep `search_volume` and `keyword_difficulty` per row.",
      "A prose sentence (with a parenthetical) is not a call.",
    ].join("\n");
    // Bare field names and prose parentheticals stay out: a gate that flags
    // prose teaches people to ignore it. Set comparison because extraction
    // follows document order, not sort order.
    expect(new Set(extractCallTokens(source))).toEqual(
      new Set(["get_geo_answer_history", "get_geo_visibility"]),
    );
  });
});

describe("harvestWireTools", () => {
  it("ignores test files, so fixtures never become wire names", () => {
    const files = new Map([
      ["src/server/mcp/tools/demo.ts", 'name: "real_tool",'],
      ["src/server/mcp/tools/demo.test.ts", 'name: "fixture_tool",'],
    ]);
    expect(harvestWireTools(files)).toEqual(new Set(["real_tool"]));
  });
});

const GOOD_YAML = [
  "interface:",
  '  display_name: "What to build"',
  '  short_description: "Turn gaps into a plan."',
  '  default_prompt: "Research keywords for my site."',
  "policy:",
  "  allow_implicit_invocation: true",
  "dependencies:",
  "  tools:",
  "    - server: opengeo",
  "      tools:",
  "        - get_domain_keyword_suggestions",
  "        - generate_content_brief",
  "",
].join("\n");

describe("parseOpenAiYaml", () => {
  it("accepts the shipped shape", () => {
    const parsed = parseOpenAiYaml(GOOD_YAML);
    expect(parsed.findings).toEqual([]);
    expect(parsed.deps.map((dep) => dep.tool)).toEqual([
      "get_domain_keyword_suggestions",
      "generate_content_brief",
    ]);
  });

  it("refuses an empty interface line", () => {
    const parsed = parseOpenAiYaml(
      GOOD_YAML.replace(
        '  default_prompt: "Research keywords for my site."',
        "",
      ),
    );
    expect(parsed.findings.join(" ")).toContain("default_prompt");
  });
});

describe("checkTree", () => {
  it("fails on a phantom call and passes when that call is removed", () => {
    const skills = new Map([
      ["demo", "Call `no_such_tool(domain)` for the gap."],
    ]);
    const failing = checkTree({
      skillSources: skills,
      wireTools: WIRE,
      depFiles: new Map(),
      servers: ["opengeo"],
    });
    expect(failing.join(" ")).toContain("no_such_tool");

    skills.set("demo", "Call `get_geo_visibility(domain)` for the gap.");
    // Floors need the live counts; the unit half runs with the floor inputs
    // supplied so the phantom is the only variable under test.
    const passing = checkTree({
      skillSources: new Map([
        ...skills,
        ...Array.from({ length: 20 }, (_, i): [string, string] => [
          `pad-${i}`,
          "no calls here",
        ]),
      ]),
      wireTools: new Set([
        ...WIRE,
        ...Array.from({ length: 100 }, (_, i) => `wire_${i}`),
      ]),
      depFiles: new Map(),
      servers: ["opengeo"],
    });
    expect(passing).toEqual([]);
  });

  it("fails on a phantom dependency tool", () => {
    const yaml = GOOD_YAML.replace(
      "        - generate_content_brief",
      "        - no_such_tool",
    );
    const findings = checkTree({
      skillSources: new Map(
        Array.from({ length: 20 }, (_, i): [string, string] => [
          `pad-${i}`,
          "no calls here",
        ]),
      ),
      wireTools: new Set([
        ...WIRE,
        ...Array.from({ length: 100 }, (_, i) => `wire_${i}`),
      ]),
      depFiles: new Map([["demo", yaml]]),
      servers: ["opengeo"],
    });
    expect(findings.join(" ")).toContain("no_such_tool");
  });

  it("tolerates comments and refuses a missing section", () => {
    const withComments = [
      "# picked by the skill author",
      ...GOOD_YAML.split("\n"),
    ].join("\n");
    expect(parseOpenAiYaml(withComments).findings).toEqual([]);
    const noPolicy = GOOD_YAML.split("\n")
      .filter((line) => !/^policy:|allow_implicit/.test(line))
      .join("\n");
    expect(parseOpenAiYaml(noPolicy).findings.join(" ")).toContain("policy:");
  });

  it("refuses an unrecognised row under tools and an empty dependency list", () => {
    const oddRow = GOOD_YAML.replace(
      "        - generate_content_brief",
      "        - generate_content_brief\n        - almost a tool",
    );
    expect(parseOpenAiYaml(oddRow).findings.join(" ")).toContain(
      "unrecognised row",
    );
    const noDeps = GOOD_YAML.split("\n")
      .filter(
        (line) =>
          !/^\s+- (server|get_)\w*/.test(line) && !/^\s*tools:\s*$/.test(line),
      )
      .join("\n");
    expect(parseOpenAiYaml(noDeps).findings.join(" ")).toContain(
      "no tool dependencies",
    );
  });

  it("fails on a dependency server the plugin does not declare", () => {
    const yaml = GOOD_YAML.replace("- server: opengeo", "- server: nowhere");
    const findings = checkTree({
      skillSources: new Map(
        Array.from({ length: 20 }, (_, i): [string, string] => [
          `pad-${i}`,
          "no calls here",
        ]),
      ),
      wireTools: new Set([
        ...WIRE,
        ...Array.from({ length: 100 }, (_, i) => `wire_${i}`),
      ]),
      depFiles: new Map([["demo", yaml]]),
      servers: ["opengeo"],
    });
    expect(findings.join(" ")).toContain("nowhere");
  });

  it("the live tree is clean: every skill call and yaml dep resolves", async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const skillsDir = join(root, ".agents", "skills");
    const skillSources = new Map();
    const depFiles = new Map();
    for (const entry of readdirSync(skillsDir)) {
      const skillFile = join(skillsDir, entry, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      skillSources.set(entry, readFileSync(skillFile, "utf8"));
      const depFile = join(skillsDir, entry, "agents", "openai.yaml");
      if (existsSync(depFile))
        depFiles.set(entry, readFileSync(depFile, "utf8"));
    }
    const mcpFiles = new Map();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (full.endsWith(".ts"))
          mcpFiles.set(full, readFileSync(full, "utf8"));
      }
    };
    walk(join(root, "src", "server", "mcp"));
    // The manifest path is covered by the gate's own CLI run, not parsed
    // here: JSON.parse is any-typed and the assertion it needs is exactly
    // what the lint family forbids without a disable.
    const servers = ["opengeo"];
    expect(
      checkTree({
        skillSources,
        wireTools: harvestWireTools(mcpFiles),
        depFiles,
        servers,
      }),
    ).toEqual([]);
  });
});
