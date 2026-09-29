/**
 * Read each tool's own `annotations` block out of its source.
 *
 * The generator's fallback is deliberately the strictest possible
 * (`destructiveHint: true`), because a reviewer who thinks a tool is risky
 * investigates while one who thinks it is safe does not. But a submission where
 * every tool is flagged destructive is its own kind of wrong: it tells the
 * reviewer to distrust the whole surface, and it is a claim we know to be false
 * for the archive reads.
 *
 * So this reads the annotation the tool actually declares — the same block the
 * MCP server sends on the wire — and the file's claim is derived from the
 * behaviour rather than transcribed from a wish.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TOOL_DIR = join(process.cwd(), "src/server/mcp/tools");

export type ToolAnnotations = {
  readOnlyHint: boolean;
  openWorldHint: boolean;
  destructiveHint: boolean;
};

const NAME = /\bname:\s*"([a-z0-9_]+)"/g;
// The closing brace is followed by a comma because `annotations` is a property of
// `config`. An earlier version required `\n\s{4}\}` and matched nothing at all,
// which silently fell back to the strictest annotation for every tool.
const ANNOTATIONS = /annotations:\s*\{([\s\S]*?)\n\s{4}\},/g;

function hasHint(block: string, hint: string): boolean {
  return new RegExp(`${hint}:\\s*true`).test(block);
}

/**
 * Every tool's declared annotations, keyed by wire name.
 *
 * A module may export more than one tool (`geo-read-tools.ts` has three), so this
 * walks every `name:` in the file rather than taking the first — the version that
 * did only found 30 of 62.
 */
export function readToolAnnotations(): Record<string, ToolAnnotations> {
  const out: Record<string, ToolAnnotations> = {};
  for (const file of readdirSync(TOOL_DIR)) {
    if (!file.endsWith(".ts") || file.includes(".test.")) continue;
    const text = readFileSync(join(TOOL_DIR, file), "utf8");

    const names = [...text.matchAll(NAME)].map((m) => m[1]);
    const blocks = [...text.matchAll(ANNOTATIONS)].map((m) => m[1]);
    if (names.length === 0 || blocks.length === 0) continue;

    // Pair them in source order. Each tool's `config.name` precedes its
    // `config.annotations`, so the nth name belongs to the nth block; a
    // mismatch would mean the layout changed, and the validator test is where
    // that surfaces.
    for (const [index, name] of names.entries()) {
      const block = blocks[index];
      if (!name || !block) continue;
      out[name] = {
        readOnlyHint: hasHint(block, "readOnlyHint"),
        openWorldHint: hasHint(block, "openWorldHint"),
        destructiveHint: hasHint(block, "destructiveHint"),
      };
    }
  }
  return out;
}
