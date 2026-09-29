import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readToolAnnotations } from "./read-tool-annotations";

/**
 * The app submission file must describe the server that actually exists.
 *
 * A submission file is a **claim about our tool surface**, and the failure mode
 * is one-directional: a tool added to the server and not to the file is a tool
 * OpenAI's reviewers cannot see, so they will not exercise it, and a tool
 * removed from the server but left in the file is a tool that 404s in review.
 * Neither shows up as an error — the submission just quietly under-represents
 * the product.
 *
 * So this is a **merge gate**, not a convenience check. The tool names are read
 * from the tools' own `name:` fields rather than derived from the exported
 * consts, because deriving a name is exactly how a file drifts from its source.
 *
 * Verified against the live schema (2026-09-28):
 *
 * - The `$schema` const is `https://developers.openai.com/plugins/schemas/...`.
 *   The older `/apps-sdk/` path still resolves, but by redirect — so it passes a
 *   casual fetch and fails a strict validator. The `/apps-sdk/` → `/plugins/`
 *   move is the July 2026 app-directory → Plugin-directory migration, and
 *   OpenAI's own submission skill doc still shows the old URL, so regenerating
 *   from that doc reintroduces the bug.
 * - `justifications` is required with **all three** fields on **every** tool,
 *   unconditionally — not only when `openWorldHint` or `destructiveHint` is
 *   true. A read-only tool still owes a `destructive_justification`.
 * - Exactly 5 positive and 3 negative test cases, and the schema's
 *   `additionalProperties: true` means a misspelled key validates silently, so
 *   the shape has to be asserted here.
 * - There is **no tool-count limit** (the often-repeated 20–25 figure is not in
 *   any current doc). The real constraint is qualitative: names and annotations
 *   must match actual behaviour.
 */

const ROOT = process.cwd();
const SUBMISSION_PATH = join(ROOT, "chatgpt-app-submission.json");
const SERVER_PATH = join(ROOT, "src/server/mcp/server.ts");
const TOOL_DIR = join(ROOT, "src/server/mcp/tools");

const submission = JSON.parse(readFileSync(SUBMISSION_PATH, "utf8")) as {
  $schema: string;
  schema_version: number;
  app_info: Record<string, unknown>;
  tools: Record<
    string,
    {
      annotations: Record<string, boolean>;
      justifications: Record<string, string>;
    }
  >;
  test_cases: Array<Record<string, unknown>>;
  negative_test_cases: Array<Record<string, unknown>>;
};

/** The wire name of every tool the server actually exposes. */
function serverToolNames(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(TOOL_DIR)) {
    if (!file.endsWith(".ts") || file.includes(".test.")) continue;
    const text = readFileSync(join(TOOL_DIR, file), "utf8");
    for (const match of text.matchAll(/\bname:\s*"([a-z0-9_]+)"/g)) {
      names.add(match[1]);
    }
  }
  // Every name in the file must be one the server registers; the reverse
  // direction is what the assertions below cover.
  const server = readFileSync(SERVER_PATH, "utf8");
  const registered = [...server.matchAll(/register\(\s*(\w+)\s*\)/g)];
  expect(
    registered.length,
    "no register() calls found — the scan pattern is stale",
  ).toBeGreaterThan(0);
  return names;
}

const serverTools = serverToolNames();
const declaredTools = Object.keys(submission.tools);

describe("chatgpt-app-submission.json", () => {
  it("points at the current schema path", () => {
    // The `/apps-sdk/` path still resolves but only by redirect, and a strict
    // validator rejects it against the schema's own `const`. It is the exact
    // URL still printed in OpenAI's own submission skill doc.
    expect(submission.$schema).toBe(
      "https://developers.openai.com/plugins/schemas/chatgpt-app-submission.v1.json",
    );
  });

  it("declares schema_version 1, which is still current", () => {
    // v2 returns 404; there is no successor to migrate to.
    expect(submission.schema_version).toBe(1);
  });

  it("declares every tool the server exposes", () => {
    // The load-bearing assertion. Fifteen tools were missing from this file
    // when it was checked — including all five GEO tools — so the reviewer saw
    // an SEO product and none of the AI-visibility work.
    const missing = [...serverTools].filter(
      (name) => !declaredTools.includes(name),
    );
    expect(
      missing,
      `tools exist but are undeclared: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("declares no tool the server has removed", () => {
    // The other direction: a stale name is a tool that fails in review, and the
    // reviewer has no way to tell that from a broken product.
    const extra = declaredTools.filter((name) => !serverTools.has(name));
    expect(extra, `declared but not served: ${extra.join(", ")}`).toEqual([]);
  });

  it("justifies all three hints on every tool, unconditionally", () => {
    // Required for every tool, not only for open-world or destructive ones. A
    // read-only tool still owes a destructive justification, and a missing one
    // is a schema error rather than a style note.
    for (const [name, tool] of Object.entries(submission.tools)) {
      for (const field of [
        "read_only_justification",
        "open_world_justification",
        "destructive_justification",
      ]) {
        const value = tool.justifications[field];
        expect(typeof value, `${name}.${field} is missing`).toBe("string");
        expect(
          (value ?? "").trim().length,
          `${name}.${field} is empty`,
        ).toBeGreaterThan(20);
      }
    }
  });

  it("declares all three annotations as booleans on every tool", () => {
    for (const [name, tool] of Object.entries(submission.tools)) {
      for (const hint of ["readOnlyHint", "openWorldHint", "destructiveHint"]) {
        expect(
          typeof tool.annotations[hint],
          `${name}.${hint} is not a boolean`,
        ).toBe("boolean");
      }
    }
  });

  it("carries exactly five positive and three negative test cases", () => {
    // "Exactly", per the portal — not "at least". And every named tool in a
    // test case must be one we actually serve, or the reviewer triggers a
    // non-existent tool and the case fails.
    expect(submission.test_cases).toHaveLength(5);
    expect(submission.negative_test_cases).toHaveLength(3);
  });

  it("only triggers tools that exist", () => {
    for (const testCase of [
      ...submission.test_cases,
      ...submission.negative_test_cases,
    ]) {
      const triggered = testCase.tools_triggered;
      if (typeof triggered !== "string") continue;
      for (const name of triggered.split(",").map((t) => t.trim())) {
        if (name.length === 0) continue;
        expect(
          serverTools.has(name),
          `test case triggers unknown tool "${name}"`,
        ).toBe(true);
      }
    }
  });

  it("gives every test case a description and a user prompt", () => {
    for (const testCase of [
      ...submission.test_cases,
      ...submission.negative_test_cases,
    ]) {
      expect(
        typeof testCase.description,
        "test case without a description",
      ).toBe("string");
      expect(
        typeof testCase.user_prompt,
        "test case without a user prompt",
      ).toBe("string");
    }
  });

  it("keeps the app info within the documented limits", () => {
    // subtitle <= 30, description <= 4000, category from a 13-value enum.
    const subtitle = String(submission.app_info.subtitle ?? "");
    const description = String(submission.app_info.description ?? "");
    expect(subtitle.length).toBeLessThanOrEqual(30);
    expect(description.length).toBeLessThanOrEqual(4000);
    expect(description.length).toBeGreaterThan(0);
  });

  it("agrees with the annotations each tool declares on the wire", () => {
    // The load-bearing claim after the generator: the file's `annotations` are
    // read from each tool's own config, not typed in by hand. If a tool's
    // annotation changes in the server and the file does not, the reviewer is
    // reading a claim we have stopped making.
    const declared = readToolAnnotations();
    for (const [name, tool] of Object.entries(submission.tools)) {
      expect(
        tool.annotations,
        `${name} has no annotations block in its source`,
      ).toBeDefined();
      expect(tool.annotations).toEqual(declared[name]);
    }
  });

  it("reads the annotations of every tool, including multi-tool modules", () => {
    // `geo-read-tools.ts` exports three tools, so a parser that took the first
    // `name:` per file would find 30 of 62 and silently label the other 32 with
    // the strictest fallback. That failure is invisible except here.
    const declared = readToolAnnotations();
    expect(Object.keys(declared).length).toBe(serverTools.size);
    // And the GEO reads are genuinely read-only, so a fallback would have been a
    // false destructive claim in a document a reviewer acts on.
    expect(declared.get_geo_visibility).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    });
  });
});
