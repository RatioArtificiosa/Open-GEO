/**
 * Regenerate `chatgpt-app-submission.json`.
 *
 * Run with `pnpm submission:generate`. The generated file is committed, because a
 * reviewer needs it in the repository — but it is *generated* so the tool surface
 * it claims cannot drift from the one the server exposes.
 *
 * Why this exists at all: the file listed 47 of 62 tools. All five GEO tools
 * were missing, so the submission described an SEO product and none of the
 * AI-visibility work — and nothing failed, because a submission file claiming
 * *less* than the server exposes produces no error anywhere. The complement is
 * worse: a tool removed from the server but left in the file is one that fails
 * in review, and the reviewer has no way to tell that from a broken product.
 *
 * The wire name of each tool is read from its own `name:` field rather than
 * derived from the exported const. Deriving a name is exactly how a generated
 * file drifts from its source, and the derivation is wrong often enough to be
 * worth avoiding.
 *
 * The justifications are the one part that must be written by hand, because they
 * are a claim about *intent* — they do not override the annotations. They live in
 * `submission-tool-justifications.ts` beside this file so the two cannot drift.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MISSING_TOOL_JUSTIFICATIONS } from "./submission-tool-justifications";
import { readToolAnnotations } from "./read-tool-annotations";

const ROOT = process.cwd();
const TARGET = join(ROOT, "chatgpt-app-submission.json");
const TOOL_DIR = join(ROOT, "src/server/mcp/tools");

/** Every `name:` the tool modules declare, which is what goes on the wire. */
function declaredNames(): string[] {
  const names: string[] = [];
  for (const file of readdirSync(TOOL_DIR)) {
    if (!file.endsWith(".ts") || file.includes(".test.")) continue;
    const text = readFileSync(join(TOOL_DIR, file), "utf8");
    for (const match of text.matchAll(/\bname:\s*"([a-z0-9_]+)"/g)) {
      names.push(match[1]);
    }
  }
  return names;
}

type ToolEntry = {
  annotations: Record<string, boolean>;
  justifications: Record<string, string>;
};

const submission = JSON.parse(readFileSync(TARGET, "utf8")) as {
  $schema: string;
  schema_version: number;
  tools: Record<string, ToolEntry>;
};

/**
 * The `/apps-sdk/` path still resolves, but only by redirect, and the schema's
 * own `const` is the `/plugins/` path — so a strict validator rejects the old
 * one while a casual fetch accepts it. The move is the July 2026 app-directory
 * to Plugin-directory migration, and OpenAI's own submission skill doc still
 * prints the stale URL, so this line is set here rather than copied from there.
 */
submission.$schema =
  "https://developers.openai.com/plugins/schemas/chatgpt-app-submission.v1.json";

let added = 0;
let corrected = 0;

const annotations = readToolAnnotations();

for (const name of declaredNames()) {
  // The annotation the tool itself declares — the same block the MCP server
  // sends on the wire — so the file's claim is derived from the behaviour
  // rather than transcribed from a wish. A tool with no annotations block falls
  // back to the strictest reading, because a reviewer who thinks a tool is
  // risky investigates while one who thinks it is safe does not.
  const declared = annotations[name] ?? {
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: true,
  };
  const justifications = MISSING_TOOL_JUSTIFICATIONS[name];

  const existing = submission.tools[name];
  if (existing) {
    // Reconcile annotations on every run, not just for new tools: an
    // annotation that changes in the server and not in the file is the same
    // drift in the other direction, and it is the one a reviewer would act on.
    const before = JSON.stringify(existing.annotations);
    const after = JSON.stringify(declared);
    if (before !== after) {
      existing.annotations = declared;
      corrected += 1;
    }
    continue;
  }

  if (!justifications) {
    // Loud on purpose: a new tool with no written justification is a tool that
    // cannot be submitted, and failing here beats failing in review.
    throw new Error(
      `No justification written for "${name}". Add one to ` +
        `scripts/submission-tool-justifications.ts before submitting.`,
    );
  }

  submission.tools[name] = { annotations: declared, justifications };
  added += 1;
}

writeFileSync(TARGET, `${JSON.stringify(submission, null, 2)}\n`);
console.log(
  `chatgpt-app-submission.json: ${added} tool(s) added, ` +
    `${corrected} annotation set(s) corrected, ` +
    `${Object.keys(submission.tools).length} total.`,
);
