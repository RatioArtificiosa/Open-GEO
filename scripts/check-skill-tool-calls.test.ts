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

// Floors satisfied on every input below (21 skills, 104 wire tools), so
// phantoms are the only variables under test and the counts the survey
// reads are exactly the findings proved. Module scope: the helpers close
// over nothing, and recreating them per block is what the lint forbids.
function paddedSkills(demo: string): Map<string, string> {
  const entries: Array<[string, string]> = [["demo", demo]];
  for (let i = 0; i < 20; i += 1) {
    entries.push(["pad-" + i, "no calls here"]);
  }
  return new Map(entries);
}
function paddedWire(): Set<string> {
  const names: string[] = [...WIRE];
  for (let i = 0; i < 100; i += 1) names.push("wire_" + i);
  return new Set(names);
}
describe("checkTree", () => {
  it("fails on a phantom call and passes when that call is removed", () => {
    const failing = checkTree({
      skillSources: paddedSkills("Call `no_such_tool(domain)` for the gap."),
      wireTools: paddedWire(),
      depFiles: new Map(),
      servers: ["opengeo"],
    });
    expect(failing).toHaveLength(1);
    expect(failing.join(" ")).toContain("no_such_tool");

    const passing = checkTree({
      skillSources: paddedSkills(
        "Call `get_geo_visibility(domain)` for the gap.",
      ),
      wireTools: paddedWire(),
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
      skillSources: paddedSkills("no calls here"),
      wireTools: paddedWire(),
      depFiles: new Map([["demo", yaml]]),
      servers: ["opengeo"],
    });
    expect(findings).toHaveLength(1);
    expect(findings.join(" ")).toContain("no_such_tool");
  });

  it("fails on a dependency server the plugin does not declare", () => {
    const yaml = GOOD_YAML.replace("- server: opengeo", "- server: nowhere");
    const findings = checkTree({
      skillSources: paddedSkills("no calls here"),
      wireTools: paddedWire(),
      depFiles: new Map([["demo", yaml]]),
      servers: ["opengeo"],
    });
    // One finding per declared tool: the survey counts the shape,
    // the name assertion proves which server it caught.
    expect(findings).toHaveLength(2);
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
