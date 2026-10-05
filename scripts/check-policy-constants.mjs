#!/usr/bin/env node
/**
 * Every declared policy constant lives in exactly one place.
 *
 * ## The blind spot this closes
 *
 * Every other gate in this repository compares things **against each other**: the
 * drift gate compares two documents, the endpoint gate compares declared paths against
 * the client's, the price-book test compares a caveat against its rate. **None of them
 * compares one decision expressed in two different files.**
 *
 * A policy literal restated as a local constant in four services is used in all four,
 * imports nothing, and duplicates nothing the compiler can name. **Every check
 * passes.** The duplication was found by a sweep somebody ran by hand, once, after
 * going looking — which is the position this repository keeps criticising.
 *
 * ## What it asserts
 *
 * For each name in `POLICIES`: exactly **one** `export const` declaration, and it
 * lives in the module the entry names. A second declaration anywhere is a failure,
 * named with both files and lines, because a reader who has to find them by hand is
 * the reader who does not.
 *
 * ## Why the list is declared rather than inferred
 *
 * Inferring which numbers are "policy" means flagging a timeout, a port and a retry
 * count in one sweep, and then a suppression list for all of them. **A gate that
 * needs a suppression list trains people to add suppressions.** So the list says which
 * numbers are decisions rather than measurements — a short list, added to on purpose.
 *
 * It is the difference between a rule and a preference, which is the distinction the
 * whole CL-819 series turned on.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

/**
 * A root-relative path with forward slashes.
 *
 * **One conversion, used everywhere.** The first version inlined
 * `file.replace(ROOT + "\\", "")`, which is Windows-specific twice
 * over — it assumes the separator is a backslash *and* that `ROOT`
 * ends in one. On Linux neither holds, so the path stayed absolute
 * and the comparison against a relative `home` failed on every
 * policy.
 *
 * A gate that only passes on the machine it was written on is not a
 * gate; it is a local custom. **CI runs on Linux.**
 */
function rel(file) {
  return relative(ROOT, file).replace(/\\/g, "/");
}

/**
 * Decisions that must be made once.
 *
 * **Adding a name here is a claim** — that this is policy rather than a measurement,
 * and that it is decided in exactly one place. The comment is why, because a list of
 * bare identifiers is a list nobody trusts.
 */
const POLICIES = [
  {
    name: "NIGHTLY_BUDGET_USD",
    /** What we permit ourselves to spend per night, per sweep. */
    home: "src/shared/nightly-budgets.ts",
  },
  {
    name: "PER_PROJECT_NIGHTLY_CAP",
    /** The per-project ceiling, so one large customer cannot take the night. */
    home: "src/shared/nightly-budgets.ts",
  },
  {
    name: "NIGHTLY_PROJECT_SWEEP_LIMIT",
    /**
     * **Not a product limit** — the patrol runner says so outright. It is a
     * first-deploy safety valve, and the reason it lives in one module is that four
     * services once restated it as `?? 25` and each comment credited the others.
     */
    home: "src/shared/nightly-budgets.ts",
  },
  {
    name: "MARKUP",
    /** What we charge over the vendor's rate. Published on /pricing. */
    home: "web/src/routes/_marketing/pricing.tsx",
  },
];

/** Every TypeScript source, because a policy can be restated anywhere. */
function sourceFiles(dir = join(ROOT, "src"), out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = [
  ...sourceFiles(join(ROOT, "src")),
  ...sourceFiles(join(ROOT, "web", "src")),
  ...sourceFiles(join(ROOT, "scripts")),
];

const problems = [];
const passes = [];

// --- 1. each policy is declared exactly once --------------------------------
for (const policy of POLICIES) {
  const declarations = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const pattern = new RegExp(`^(?:export )?const ${policy.name}\\b`, "gm");
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const line = text.slice(0, match.index).split("\n").length;
      declarations.push({
        file: rel(file),
        line,
        exported: match[0].startsWith("export"),
      });
    }
  }

  if (declarations.length === 0) {
    problems.push(`${policy.name}: declared nowhere — is the name right?`);
    continue;
  }

  if (declarations.length > 1) {
    problems.push(
      `${policy.name}: declared ${declarations.length} times — ` +
        declarations.map((d) => `${d.file}:${d.line}`).join(", "),
    );
    continue;
  }

  // --- 2. and it lives where the entry says --------------------------------
  const [only] = declarations;
  if (only.file !== policy.home) {
    problems.push(
      `${policy.name}: declared in ${only.file}:${only.line}, but the entry says ${policy.home}`,
    );
    continue;
  }

  if (!only.exported) {
    problems.push(
      `${policy.name}: declared without the export keyword in ${only.file}:${only.line} — ` +
        "a policy nothing can import is a copy waiting to happen",
    );
    continue;
  }

  passes.push(`${policy.name} declared once, in ${only.file}`);
}

// --- 3. a local copy of a policy's NAME ------------------------------------
/**
 * **On names, not on values.**
 *
 * The first version of this check matched a local constant whose *value* equalled a
 * policy's, and reported `COUNTRY_ROW_LIMIT = 25` as a restatement of
 * `NIGHTLY_PROJECT_SWEEP_LIMIT = 25`. It is not:
 *
 * - the sweep limit is **policy** — how many customers one nightly tick may touch, a
 *   decision somebody made;
 * - the country limit is a **measurement** — the vendor's own cap on rows per country
 *   in a Search Console response, which nobody here decided.
 *
 * **Same number, unrelated unit.** A bare literal carries no semantics, so matching on
 * values cannot tell them apart — and the obvious response, a suppression list, is how
 * a gate starts training people to add suppressions instead of reading findings.
 *
 * **A gate that needs a suppression list has chosen the wrong rule.** So this checks
 * the thing that is unambiguous: a name that collides with a policy while living
 * somewhere else. `COUNTRY_ROW_LIMIT` collides with nothing, so it is not reported,
 * and nothing needs excusing.
 */
for (const policy of POLICIES) {
  for (const file of files) {
    if (file.replace(/\\/g, "/").endsWith(policy.home)) continue;

    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, i) => {
      // **The policy's own name, declared locally.** Not its value: the value is a
      // coincidence waiting to happen, and the name is not.
      const local = new RegExp(`^(?:const|let|var) ${policy.name}\\b`).exec(
        line,
      );
      if (local) {
        problems.push(
          `${rel(file)}:${i + 1} declares a local ` +
            `${policy.name}, which is decided in ${policy.home}`,
        );
      }
    });
  }
}

// --- 4. the published figure says what the code does -----------------------
/**
 * The homepage says *"a flat 28%, the same on every endpoint"*, and the
 * receipt prints the same figure in its total row. Those are **copies of the
 * number the code charges by** — six of them, across the homepage, the
 * receipt, `/capabilities`, `/open-source-seo` and the business-model gate.
 *
 * **Change `MARKUP` and every one of them becomes a false claim with nothing
 * red.** That is the duplicated-constant failure one layer up: a published
 * figure that can drift from the number it describes turns a checkable claim
 * into an unverifiable one.
 *
 * ## The assertion: presence, not purity
 *
 * Each page that publishes the markup must state the figure the code charges.
 * **Not** "every percentage on the page equals the markup" — a page also
 * carries an open-source claim, a discount and a zero, none of which are the
 * markup, and a rule that demanded they all be 28% would fail on a correct
 * page.
 *
 * So: read the markup from the code, compute the percentage, and require that
 * percentage to appear on each page. Change `MARKUP` to `1.9` and the code
 * charges 90% while the pages still say 28% — present, but not the figure we
 * charge — so the rule fails.
 *
 * ## The vacuity guard
 *
 * The first version of this rule was generated through a script, and the
 * escaping ate the backslashes: `([\\d.]+)` became `([d.]+)` and
 * `/\\b28\\s?%/` became `/28s?%/`. **It matched nothing and passed**,
 * reporting agreement it had never tested.
 *
 * So a page that states no percentage is a failure, not a pass. **A gate that
 * cannot see the string it exists to find must say so rather than report
 * success** — and the check for that is cheaper than the outage.
 */
{
  const DIST = join(ROOT, "web", "dist", "client");
  const PAGES = [
    "index.html",
    "pricing/index.html",
    "open-source-seo/index.html",
  ];

  const pricingSource = readFileSync(
    join(ROOT, "web/src/routes/_marketing/pricing.tsx"),
    "utf8",
  );
  const markupLine =
    /^export const MARKUP = .*$/m.exec(pricingSource)?.[0] ?? "";
  const figure = /(\d+(?:\.\d+)?)/.exec(markupLine)?.[1];
  const expected = Number.parseFloat(figure ?? "");
  const percent = Number.isFinite(expected)
    ? Math.round((expected - 1) * 100)
    : null;

  if (percent === null) {
    problems.push(
      "MARKUP: not a plain number, so the published figure cannot be checked",
    );
  } else {
    const wrong = [];
    const unseen = [];

    for (const page of PAGES) {
      const file = join(DIST, page);
      if (!existsSync(file)) {
        wrong.push(
          `${page} is not in the build — run the build before this gate`,
        );
        continue;
      }

      // **Text content, not raw HTML.** React separates adjacent text
      // nodes with `<!-- -->`, so a phrase like `{x}%` arrives as
      // `<!-- -->28<!-- -->%`, which no pattern spanning the boundary
      // can match. Comments are markup, not content — no visitor sees
      // them — so they are removed before scanning, as are tags, which
      // is also what keeps a CSS `calc(100%-2px)` class from reading
      // as a stated percentage.
      const text = readFileSync(file, "utf8")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/&[a-z#0-9]+;/gi, " ")
        .replace(/\s+/g, " ");
      const stated = [...text.matchAll(/(\d+)\s?%/g)].map((m) =>
        Number.parseInt(m[1], 10),
      );

      if (stated.length === 0) {
        unseen.push(
          `${page} states no percentage at all, so this rule cannot check it`,
        );
        continue;
      }

      // **The figure we charge must be among them.** Other percentages on the
      // page are other claims and are none of this rule's business.
      if (!stated.includes(percent)) {
        wrong.push(
          `${page} states ${[...new Set(stated)]
            .map((p) => `${p}%`)
            .join(", ")} but not ${percent}%, which is what we charge`,
        );
      }
    }

    if (wrong.length > 0) {
      problems.push(
        `the published markup does not match the code (${percent}% is what we charge): ` +
          wrong.join("; "),
      );
    } else if (unseen.length > 0) {
      problems.push(
        `the published-markup rule could not read the pages it checks: ${unseen.join("; ")}`,
      );
    } else {
      passes.push(
        `the published markup agrees with the code (${percent}% is stated on every page that publishes one)`,
      );
    }
  }
}

console.log(`policy constants — ${POLICIES.length} decisions`);
for (const p of passes) console.log(`  ok   ${p}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  FAIL ${p}`);
  console.error(
    "\nA policy restated as a local copy is used, imports nothing, and duplicates\n" +
      "nothing a compiler can name — so every other gate stays green. That is why\n" +
      "this one exists.",
  );
  process.exit(1);
}

console.log("\nclean");
