/**
 * Do the hand-written justifications and the generated submission file agree?
 *
 * ## Why this exists
 *
 * `pnpm submission:generate` reconciles **annotations** on every run but only
 * writes justifications for tools it has not seen. So editing a justification
 * in `scripts/submission-tool-justifications.ts` leaves the committed file
 * holding the old text — two files disagreeing about the same tool, which is
 * the drift this project keeps finding in its own documents.
 *
 * ## Why this imports rather than parses
 *
 * Three versions of this file read the source with regular expressions, and
 * every one of them was wrong in a way that reported confidently:
 *
 * 1. It held its own copies of `PRIVATE_STATE` and `NOTHING_DESTRUCTIVE`, so
 *    changing the real constants left the check comparing a stale value against
 *    itself and passing.
 * 2. It parsed only the inlined-string spelling, read 5 entries of 26, and
 *    reported the ones it *could* read as disagreeing when the real problem was
 *    that it had skipped the rest.
 * 3. With the spellings widened it parsed all 26 and reported **46 fields
 *    differing** — against a source and a generated file that a direct read
 *    showed were byte-identical. The regex extracted `""`.
 *
 * That third one is the lesson worth keeping, and it is the same shape as the
 * `never[]` stand-in this repo has already recorded: **a stand-in that constrains
 * nothing is worse than a real one, because it produces confident wrong
 * answers rather than obvious failures.** TypeScript can be executed. A
 * `.ts` module that is imported cannot disagree with itself.
 *
 * The trade is that this file runs under `tsx` rather than plain node, so it is
 * invoked through a package script — which is also where it belongs, since
 * `ci:check` already runs `tsc` over the same module.
 */
import { readFileSync } from "node:fs";
import { MISSING_TOOL_JUSTIFICATIONS } from "./submission-tool-justifications.ts";

const GENERATED = "chatgpt-app-submission.json";

const submission = JSON.parse(readFileSync(GENERATED, "utf8"));
const generated: Record<string, { justifications?: Record<string, string> }> =
  submission.tools ?? {};

const FIELDS = [
  "read_only_justification",
  "open_world_justification",
  "destructive_justification",
] as const;

const problems: string[] = [];

for (const [name, entry] of Object.entries(MISSING_TOOL_JUSTIFICATIONS)) {
  const target = generated[name];
  if (!target) {
    problems.push(`${name} is missing from ${GENERATED}`);
    continue;
  }
  for (const field of FIELDS) {
    const expected = entry[field];
    const actual = target.justifications?.[field];
    if (actual !== expected) {
      problems.push(
        `${name}.${field} differs — ${GENERATED} holds text the source does not.`,
      );
    }
  }
}

console.log(
  `hand-written entries parsed: ${Object.keys(MISSING_TOOL_JUSTIFICATIONS).length}`,
);
console.log(`tools in the generated file: ${Object.keys(generated).length}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    `\n${GENERATED} is out of step with the source. \`pnpm submission:generate\` will NOT ` +
      "fix it: the generator reconciles annotations on every run but only writes " +
      "justifications for tools it has not seen. Copy the wording from the source into the " +
      "generated file by hand — the source is the one that gets edited.",
  );
  process.exit(1);
}

console.log(
  "PASS: every hand-written justification matches the generated file.",
);
