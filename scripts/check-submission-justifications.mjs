/**
 * Do the hand-written justifications and the generated submission file agree?
 *
 * `pnpm submission:generate` reconciles **annotations** on every run but only
 * writes justifications for tools it has not seen. So editing a justification
 * in `scripts/submission-tool-justifications.ts` leaves the generated file
 * holding the old text — two files disagreeing, which is the drift this
 * project keeps finding in its own documents.
 *
 * CodeRabbit flagged the mismatch. This check makes it a failure instead.
 */
import { readFileSync } from "node:fs";

const source = readFileSync(
  "scripts/submission-tool-justifications.ts",
  "utf8",
);
const submission = JSON.parse(
  readFileSync("chatgpt-app-submission.json", "utf8"),
);

/**
 * Pull the `name: { ... }` blocks out of the source without evaluating it.
 *
 * **Handles both spellings.** Most entries inline the three strings; a few
 * reference the module constants (`open_world_justification: PRIVATE_STATE`).
 * The first version of this parser only matched the inlined form, so it parsed
 * 5 of 12 entries and reported the ones it *could* read as disagreeing when the
 * real difference was that it had skipped them. **A checker that cannot read
 * its own input reports confidently wrong answers**, which is worse than no
 * checker.
 */
function parseJustifications() {
  const out = new Map();
  // Resolve the shorthand constants the same way the module does.
  const constants = {
    PRIVATE_STATE:
      "Operates only on private OpenGeo state or private provider data and cannot change publicly visible internet state.",
    NOTHING_DESTRUCTIVE:
      "Does not delete, overwrite, revoke access, send messages, or perform irreversible actions.",
  };

  const pattern = /^\s{2}([a-z0-9_]+):\s*\{([\s\S]*?)^\s{2}\},?$/gm;
  let m;
  while ((m = pattern.exec(source)) !== null) {
    const [, name, body] = m;
    if (!name || !body) continue;
    const readField =
      /read_only_justification:\s*(?:"([\s\S]*?)"|([A-Z_]+)),/.exec(body);
    if (!readField) continue;
    const pick = (field) =>
      field ? (field[1] ?? constants[field[2] ?? ""] ?? field[2] ?? "") : "";
    out.set(name, {
      read_only_justification: pick(readField),
      open_world_justification: pick(
        /open_world_justification:\s*(?:"([\s\S]*?)"|([A-Z_]+)),/.exec(body),
      ),
      destructive_justification: pick(
        /destructive_justification:\s*(?:"([\s\S]*?)"|([A-Z_]+)),/.exec(body),
      ),
    });
  }
  return out;
}

const hand = parseJustifications();
const generated = submission.tools ?? {};

const missing = [...hand.keys()].filter((name) => !(name in generated));
const mismatched = [];
for (const [name, values] of hand) {
  const entry = generated[name]?.justifications;
  if (!entry) continue;
  for (const key of Object.keys(values)) {
    if (entry[key] !== values[key]) {
      mismatched.push(`${name}.${key}`);
    }
  }
}

console.log(`hand-written entries parsed: ${hand.size}`);
console.log(`tools in the submission file: ${Object.keys(generated).length}`);
console.log(
  `in the source but not generated: ${missing.length}${missing.length ? ` → ${missing.join(", ")}` : ""}`,
);
console.log(
  `justifications that disagree: ${mismatched.length}${mismatched.length ? ` → ${mismatched.join(", ")}` : ""}`,
);

if (missing.length > 0 || mismatched.length > 0) {
  console.error(
    "\nThe submission file and the justifications source disagree. " +
      "Regenerate, or run this script's diff to see which is stale.",
  );
  process.exit(1);
}
console.log(
  "\nPASS: every hand-written justification matches the generated file.",
);
