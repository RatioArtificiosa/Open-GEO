#!/usr/bin/env node
/**
 * CL-213g's standing rule: every tool a product skill tells an agent to call
 * must exist on the MCP wire, and every `agents/openai.yaml` dependency must
 * name a real server and real tools.
 *
 * ## The defect class, and why it hid
 *
 * Three product skills named tools that do not exist: `geo-audit` sent agents
 * to `geo_search_mentions(target, query, platform, limit)`, `what-to-build`
 * sent them to `geo_content_gaps(domain, competitors)` with `domain_intersection`
 * as the "underlying" alternative, and its brief step priced a
 * `generate_sub_topics` ($0.0001/task) call. None of those names is on the
 * wire. An agent following the skill gets tool-not-found on step one — the
 * same failure CL-210-mcp fixed for `compute_share_of_voice`, which was then
 * a missing tool and is now a real one.
 *
 * It hid for two structural reasons. First, skills are prose: no import to
 * resolve, no type to check, so nothing failed when the names drifted.
 * Second, the calls wear two shapes — inline `` `name(args)` `` and fenced
 * blocks where the call sits alone on its line with no backticks at all —
 * so a detector written for one shape passes the other forever.
 *
 * ## What is checked
 *
 * 1. Every call-position token in every SKILL.md under .agents/skills names a
 *    wire tool. Call position means an inline backticked `` `name(` `` or a
 *    line whose stripped text starts with `name(` (the fenced shape).
 * 2. Every `agents/openai.yaml` declares a non-empty interface
 *    (display_name, short_description, default_prompt), a policy boolean,
 *    and dependencies whose server is a plugin MCP server and whose tools
 *    are all wire tools.
 * 3. The scan is not vacuous: the wire harvest must find at least 90 tools
 *    (99 on 2026-10-16, exact both directions against the submission file)
 *    and at least 14 skills.
 *
 * ## What this gate cannot check
 *
 * Bare name references with no call shape (`` `generate_sub_topics` `` with
 * the parens outside the backticks, field names like `search_volume`,
 * `dry_run`). Those are prose until proven otherwise, and a gate that flags
 * prose teaches people to ignore it. The bare-ref half is review discipline
 * plus the negative control below, not a regex.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(repoRoot, ".agents", "skills");
const MCP_DIR = join(repoRoot, "src", "server", "mcp");
const PLUGIN_MANIFEST = join(
  repoRoot,
  "plugins",
  "opengeo",
  ".codex-plugin",
  "plugin.json",
);

export const WIRE_TOOL_FLOOR = 90;
export const SKILL_COUNT_FLOOR = 14;

/**
 * Call-position tokens in one skill body: inline `` `name( `` plus fenced
 * lines whose stripped text starts with `name(`. Sorted, deduplicated.
 */
export function extractCallTokens(source) {
  const found = new Set();
  for (const match of source.matchAll(/`([a-z][a-z0-9_]*)\s*\(/g)) {
    found.add(match[1]);
  }
  for (const line of source.split("\n")) {
    const stripped = line.trim();
    const fenceCall = /^[a-z][a-z0-9_]*\s*\(/.exec(stripped);
    if (fenceCall) found.add(/^[a-z][a-z0-9_]*/.exec(stripped)[0]);
  }
  return [...found];
}

/**
 * Wire tool names: every `name: "..."` literal in non-test MCP sources.
 * Proven exact (99/99 both directions) against the submission surface.
 */
export function harvestWireTools(files) {
  const names = new Set();
  for (const [path, source] of files) {
    if (path.endsWith(".test.ts")) continue;
    for (const match of source.matchAll(/name:\s*"([a-z][a-z0-9_]*?)"/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

/**
 * Strict reader for the `agents/openai.yaml` shape CL-213g ships. Anything
 * outside the documented shape is a finding, not a skip: a lenient parser
 * passes a drifted file forever.
 */
export function parseOpenAiYaml(text) {
  const findings = [];
  const get = (key) => {
    const match = new RegExp("^\\s{2}" + key + ":\\s*(.+?)\\s*$", "m").exec(
      text,
    );
    return match ? match[1].replace(/^"|"$/g, "") : "";
  };
  const iface = {
    display_name: get("display_name"),
    short_description: get("short_description"),
    default_prompt: get("default_prompt"),
  };
  for (const [key, value] of Object.entries(iface)) {
    if (value === "")
      findings.push("interface." + key + " is empty or missing");
  }
  if (!/^\s{2}allow_implicit_invocation:\s*(true|false)\s*$/m.test(text)) {
    findings.push(
      "policy.allow_implicit_invocation is not an explicit boolean",
    );
  }
  // The three top-level sections the shipped shape carries. A file missing
  // one is drift, not a variant: the parser below keys off them.
  for (const section of ["interface:", "policy:", "dependencies:"]) {
    if (!new RegExp("^" + section + "\\s*$", "m").test(text)) {
      findings.push("top-level section " + section + " is missing");
    }
  }
  const deps = [];
  const lines = text.split("\n");
  let section = "";
  let server = "";
  let inTools = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const header = /^(interface|policy|dependencies):\s*$/.exec(trimmed);
    if (header) {
      section = header[1];
      server = "";
      inTools = false;
      continue;
    }
    if (section !== "dependencies") continue;
    const serverMatch = /^\s*- server:\s*(\S+)\s*$/.exec(line);
    if (serverMatch) {
      server = serverMatch[1];
      inTools = false;
      continue;
    }
    if (/^\s*tools:\s*$/.test(line) && server !== "") {
      inTools = true;
      continue;
    }
    if (inTools && server !== "") {
      const toolMatch = /^\s*- ([a-z][a-z0-9_]*)\s*$/.exec(line);
      if (toolMatch) {
        deps.push({ server, tool: toolMatch[1] });
      } else if (/^\s*-\s*\S/.test(line)) {
        findings.push("unrecognised row under tools: " + trimmed);
      }
      continue;
    }
  }
  if (deps.length === 0) {
    findings.push("declares no tool dependencies");
  }
  return { iface, deps, findings };
}

export function checkTree({ skillSources, wireTools, depFiles, servers }) {
  const findings = [];
  if (wireTools.size < WIRE_TOOL_FLOOR) {
    findings.push(
      `wire harvest found ${wireTools.size} tools, floor is ${WIRE_TOOL_FLOOR}: the scan is vacuous`,
    );
  }
  if (skillSources.size < SKILL_COUNT_FLOOR) {
    findings.push(
      `scanned ${skillSources.size} skills, floor is ${SKILL_COUNT_FLOOR}: the scan is vacuous`,
    );
  }
  for (const [skill, source] of skillSources) {
    for (const token of extractCallTokens(source)) {
      if (!wireTools.has(token)) {
        findings.push(
          `${skill}/SKILL.md calls \`${token}(...)\` which is not an MCP tool on the wire`,
        );
      }
    }
  }
  for (const [skill, yaml] of depFiles) {
    const parsed = parseOpenAiYaml(yaml);
    for (const finding of parsed.findings) {
      findings.push(`${skill}/agents/openai.yaml: ${finding}`);
    }
    for (const dep of parsed.deps) {
      if (!servers.includes(dep.server)) {
        findings.push(
          `${skill}/agents/openai.yaml depends on server "${dep.server}" which the plugin manifest does not declare`,
        );
      }
      if (!wireTools.has(dep.tool)) {
        findings.push(
          `${skill}/agents/openai.yaml depends on tool "${dep.tool}" which is not an MCP tool on the wire`,
        );
      }
    }
  }
  return findings;
}

function readTree(dir, suffix, out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      readTree(full, suffix, out);
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      out.set(full, readFileSync(full, "utf8"));
    }
  }
  return out;
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
})();

if (isMain) {
  const skillSources = new Map();
  for (const entry of readdirSync(SKILLS_DIR)) {
    const skillFile = join(SKILLS_DIR, entry, "SKILL.md");
    if (existsSync(skillFile)) {
      skillSources.set(entry, readFileSync(skillFile, "utf8"));
    }
  }
  const wireTools = harvestWireTools(readTree(MCP_DIR, ".ts"));
  const depFiles = new Map();
  for (const skill of skillSources.keys()) {
    const depFile = join(SKILLS_DIR, skill, "agents", "openai.yaml");
    if (existsSync(depFile)) {
      depFiles.set(skill, readFileSync(depFile, "utf8"));
    }
  }
  const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, "utf8"));
  const servers = Object.keys(manifest.mcpServers ?? {});
  const findings = checkTree({ skillSources, wireTools, depFiles, servers });
  console.log(
    `check-skill-tool-calls: ${wireTools.size} wire tools, ${skillSources.size} skills, ${depFiles.size} openai.yaml files, ${findings.length} findings.`,
  );
  for (const finding of findings) console.error("  " + finding);
  process.exit(findings.length === 0 ? 0 : 1);
}
