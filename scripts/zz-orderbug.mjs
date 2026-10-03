// **CodeRabbit's `major` is correct, and it is a bug I introduced two hours ago.**
//
// ```
// normaliseAiKeyword:  keyword.trim().toLowerCase().slice(0, 250)   ← clamp LAST
// normaliseColumn:     lower(trim(substr(col, 1, 250)))             ← clamp FIRST
// ```
//
// **The order matters, and I did not think about it when I added the clamp.** Consider a
// prompt whose first 250 characters are `ABC` followed by trailing spaces:
//
// ```
// "ABC" + 200 spaces + "DEF"
//   len 206
//
// correct (clamp last):  trim → "ABC…DEF" (204) → lower → slice 250 → "abc…def"
// mine    (clamp first):  substr 1..250 → "ABC" + 200 spaces → trim → "ABC" → lower → "abc"
// ```
//
// **Different strings.** The vendor stored the first; the join compares the second; nothing
// matches; the prompt is never-measured forever — **the exact bug the clamp was added to
// fix, reintroduced by the fix.**
//
// Prove it with real SQLite rather than by reading, which is what twelve runs of theory
// cost me earlier today.
import { createClient } from "@libsql/client";

const client = createClient({ url: "file::memory:" });
await client.execute("CREATE TABLE t (v text)");

const MAX = 250;
const normalise = (k) => k.trim().toLowerCase().slice(0, MAX);
const mineSql = (col) => `lower(trim(substr(${col}, 1, ${MAX})))`;
const rightSql = (col) => `lower(trim(substr(${col}, 1, ${MAX})))`;

// Cases where clamping before trimming differs from clamping after.
const cases = [
  ["trailing spaces past 250", "ABC" + " ".repeat(200) + "DEF"],
  ["leading spaces pushing content out", " ".repeat(300) + "HELLO"],
  ["both ends padded", "  " + "X".repeat(248) + "  "],
  ["exactly 250, padded", "Y".repeat(248) + "  "],
  ["short, unaffected", "best crm software"],
  ["exactly 250, clean", "Z".repeat(250)],
];

// The correct SQL: clamp AFTER trim+lower is not expressible as one substr, so the honest
// SQL is `substr(lower(trim(col)), 1, 250)`.
const correctSql = (col) => `substr(lower(trim(${col})), 1, ${MAX})`;

console.log("=== does clamp-first differ from clamp-last? ===\n");
console.log(
  "  prompt                              | mine == vendor? | correct == vendor?",
);
console.log(
  "  ------------------------------------|-----------------|-------------------",
);

for (const [label, prompt] of cases) {
  await client.execute("DELETE FROM t");
  await client.execute("INSERT INTO t (v) VALUES (?)", [prompt]);

  const vendor = normalise(prompt);

  const mineRows = await client.execute(`SELECT ${mineSql("v")} AS n FROM t`);
  const mine = mineRows.rows[0].n;

  const rightRows = await client.execute(
    `SELECT ${correctSql("v")} AS n FROM t`,
  );
  const right = rightRows.rows[0].n;

  console.log(
    `  ${label.padEnd(36)} | ${String(mine === vendor).padEnd(15)} | ${right === vendor}`,
  );
}

console.log("\n=== so the fix is an order, not a number ===");
console.log("  mine   : lower(trim(substr(col, 1, 250)))");
console.log("  correct : substr(lower(trim(col)), 1, 250)");
console.log(
  "\n  **The clamp must be OUTSIDE**, because a prompt with padding inside the first",
);
console.log(
  "  250 characters loses its real content to the clamp before the trim removes it.",
);
console.log("  The number was right; the position was not.");
