#!/usr/bin/env node
// Which GEO response fields does no client read?
//
// Run it, read the list, decide what to do. It is a **tool and not a gate**, and
// that is a measured decision rather than a cautious one.
//
// ## Why it is not a gate
//
// Run against the tree as it stands, it reports **68 unread fields**. Sorted:
//
// | Bucket | Count | What it is |
// |---|---|---|
// | Prototype members | 25 | `charCodeAt`, `substring`, `toExponential` — reached through a union or a Map value. Never response fields. |
// | HTML entities | 10 | `big`, `bold`, `sup`… fields of a shared markdown renderer that reaches a GEO type. |
// | Unmounted endpoints | 9 | Fields of the 6 server functions with no client at all (P4). A missing screen, not a dropped field. |
// | Candidates | 24 | The only bucket worth a human. **6 of the 24 are read indirectly** — destructured, or passed through a spread — which no property-access scan can see. |
//
// So a gate here would need an 18-entry exemption list *and* would still be blind to
// a quarter of its own candidates. That is a gate nobody keeps, and this repository
// has already thrown away two detector versions for the same reason. **The probe's
// value is that it runs in 30 seconds and tells you where to look — not that it can
// assert.** A gate is the wrong instrument for a question whose honest answer is
// "here are 24 places, 6 of which I cannot see".
//
// ## The three versions that got it wrong first
//
// Every one of them reported success while measuring nothing, which is why each is
// written down here rather than in the commit history:
//
// 1. **It read the transport wrapper's type.** Asking for the type of the whole
//    `.handler(...)` chain returns the server-function object's shape — `method`,
//    `__executeServer`, a compiler-mangled internal. 69 findings, none real.
// 2. **It handled block bodies only.** Most handlers are concise arrows whose body is
//    the expression, so it examined **4 of 23 handlers** and printed "1 finding" as
//    though it had covered the file.
// 3. **It never unwrapped the `Promise`.** Every handler is `async`, and
//    `getProperties()` on `Promise<Shape>` returns the promise's own shape — nothing.
//    So every field was invisible and the probe reported a clean bill of health on a
//    codebase with the defect still in it.
//
// **A synthetic control fixture was green through all three.** The control that
// caught #3 was reverting the real fix and re-running: `forecast.direction` is the
// field this probe was built to find, so the honest test is whether it finds a field
// that is genuinely unread, not whether it passes.
//
// ## What it found, for real
//
// `promptsAsked` — the denominator behind every mention rate this product publishes,
// written on every snapshot, computed by the patrol, and read by no client. And
// `aliases` on a monitored target, stored and never rendered. Both are honesty
// fields, which is what makes them worth surfacing rather than deleting.
//
// ## Its remaining blind spot, and why it matters more than the noise
//
// **A field consumed on the server to derive another field reads as unread here.**
// `getGeoEvidence` returns `requestBody` and `responseBody`, and no client touches
// them — but `evidenceDrawer.ts` reads both to decide whether to emit a
// `missing_request` or `truncated_response` **gap**, and the `gaps` array is what the
// drawer actually shows. The bodies are read; the reading happens upstream of the
// screen.
//
// So those three findings are **not** defects, and the honest response is to leave
// them alone. What must not happen is a future session "fixing" them by deleting the
// bodies from the response: that removes the evidence the drawer detects its own
// gaps from, and the gap detection would quietly stop working with nothing failing.
// This paragraph is the only thing standing between the next reader and that
// deletion, which is why it lives here rather than in a commit message.
import ts from "typescript";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

/**
 * Prototype members reached through a union or a Map value.
 *
 * Not response fields. A denylist rather than an allowlist because the alternative
 * is enumerating every field of every domain model, which is a list nobody
 * maintains.
 */
const NOT_A_FIELD = new Set([
  // String
  "charCodeAt",
  "codePointAt",
  "substring",
  "substr",
  "normalize",
  "repeat",
  "toLocaleUpperCase",
  "toLocaleLowerCase",
  "padStart",
  "padEnd",
  "trimEnd",
  "trimStart",
  "trimLeft",
  "trimRight",
  "matchAll",
  "toExponential",
  "toPrecision",
  "localeCompare",
  "at",
  // Number
  "toFixed",
  "toExponential",
  "toPrecision",
  // Array
  "concat",
  "lastIndexOf",
  "reverse",
  "shift",
  "unshift",
  "reduceRight",
  "fill",
  "copyWithin",
  "flat",
  "flatMap",
  "push",
  "pop",
  "splice",
  "slice",
  "indexOf",
  "includes",
  "join",
  "sort",
  "keys",
  "values",
  "entries",
  "length",
  "find",
  "findIndex",
  "forEach",
  "map",
  "filter",
  "reduce",
  "some",
  "every",
  "toSorted",
  "toReversed",
  "toSpliced",
  "groupBy",
  // Object / misc
  "valueOf",
  "toString",
  "then",
  "catch",
  "finally",
]);

/** The HTML-entity fields of a shared markdown renderer that reaches GEO types. */
const MARKDOWN_ENTITY = new Set([
  "big",
  "blink",
  "bold",
  "fixed",
  "fontcolor",
  "fontsize",
  "italics",
  "small",
  "strike",
  "sup",
]);

const SURFACE = ["src/routes/", "src/client/"];

const config = ts.readConfigFile(
  path.join(ROOT, "tsconfig.json"),
  ts.sys.readFile,
);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

/**
 * Every property name a route or component touches — **plus every name it binds**.
 *
 * Destructuring counts as a read, and that is not a nicety: `VisibilityForecast.tsx`
 * binds `const { forecast, series } = await getGeoVisibilityForecast(...)`, so
 * `forecast` and `series` are read by name without a single `.forecast` in the
 * source. A property-access scan alone reported both as unread — the two fields this
 * session had most recently touched — which is the fastest way to make a maintainer
 * stop trusting a tool.
 */
const accessed = new Set();
let surfaceFiles = 0;
for (const sf of program.getSourceFiles()) {
  const rel = sf.fileName.replace(/\\/g, "/");
  if (sf.isDeclarationFile || !SURFACE.some((p) => rel.includes(p))) continue;
  surfaceFiles += 1;
  const visit = (n) => {
    if (ts.isPropertyAccessExpression(n)) {
      accessed.add(n.name.getText());
    } else if (
      ts.isElementAccessExpression(n) &&
      ts.isStringLiteral(n.argumentExpression)
    ) {
      accessed.add(n.argumentExpression.text);
    }
    // Destructuring, with or without a rename: `const { a }`, `const { a: b }`.
    if (ts.isBindingElement(n)) {
      const name = n.propertyName ?? n.name;
      if (ts.isIdentifier(name)) accessed.add(name.getText());
      else if (ts.isStringLiteral(name)) accessed.add(name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

/** Server functions a client imports, so P4 is not reported as a dropped field. */
const mounted = new Set();
for (const sf of program.getSourceFiles()) {
  const rel = sf.fileName.replace(/\\/g, "/");
  if (sf.isDeclarationFile || !SURFACE.some((p) => rel.includes(p))) continue;
  const src = sf.getFullText();
  for (const m of src.matchAll(
    /\b(get|list|create|delete|upsert)Geo[A-Za-z]+\b/g,
  )) {
    mounted.add(m[0]);
  }
}

/** field -> the endpoint that returns it, where that can be determined. */
const owner = new Map();
const findings = new Map();

for (const sf of program.getSourceFiles()) {
  if (!sf.fileName.replace(/\\/g, "/").includes("src/serverFunctions/geo.ts"))
    continue;

  /**
   * The handler is a child of the endpoint's initializer, so tracking the current
   * endpoint in a variable — rather than requiring a node to be *both* — is what
   * makes them meet. The first version checked `isVariableDeclaration` and
   * `isArrowFunction` on the same node, which can never both be true, and reported
   * **0 findings on a tree with 24**: a tool that reports nothing is
   * indistinguishable from a tool that works.
   */
  let endpoint = null;

  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const name = n.name.getText();
      if (/^(get|list|create|delete|upsert)Geo/.test(name)) {
        endpoint = name;
        ts.forEachChild(n, visit);
        // Not restored on purpose: a module's declarations do not nest, and
        // restoring would need a stack for no case that occurs.
        return;
      }
    }

    if (endpoint && (ts.isArrowFunction(n) || ts.isFunctionExpression(n))) {
      const body = n.body;
      if (!body) return;
      const exprs = [];
      if (ts.isBlock(body)) {
        const inner = (b) => {
          if (ts.isReturnStatement(b) && b.expression) exprs.push(b.expression);
          ts.forEachChild(b, inner);
        };
        inner(body);
      } else {
        exprs.push(body);
      }

      for (const e of exprs) {
        const raw = checker.getTypeAtLocation(e);
        if (raw.flags & ts.TypeFlags.Void) continue;
        // **Awaited<T>** — what the client receives, not the Promise's own shape.
        const t = checker.getAwaitedType(raw) ?? raw;

        const collect = (type, depth) => {
          if (depth > 2) return;
          if (checker.isArrayType(type)) {
            const args = checker.getTypeArguments(type);
            if (args && args[0]) collect(args[0], depth);
            return;
          }
          for (const p of type.getProperties()) {
            const name = p.getName();
            if (name.startsWith("__")) continue;
            if (NOT_A_FIELD.has(name)) continue;
            if (MARKDOWN_ENTITY.has(name)) continue;
            if (!accessed.has(name)) {
              findings.set(name, (findings.get(name) ?? 0) + 1);
              if (!owner.has(name)) owner.set(name, endpoint);
            }
            const decl = p.valueDeclaration ?? p.declarations?.[0];
            if (decl) {
              const inner = checker.getTypeOfSymbolAtLocation(p, decl);
              if (inner && inner.getProperties().length > 0) {
                collect(inner, depth + 1);
              }
            }
          }
        };
        collect(t, 0);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

const candidates = [...findings.entries()]
  .filter(([name]) => !owner.get(name) || mounted.has(owner.get(name)))
  .sort((a, b) => b[1] - a[1]);

const unmounted = [...findings.entries()].filter(
  ([name]) => owner.get(name) && !mounted.has(owner.get(name)),
);

console.log(`surface files scanned: ${surfaceFiles}`);
console.log(`handlers examined:     ${new Set([...owner.values()]).size}`);
console.log(`unread fields total:   ${findings.size}`);
console.log("");
console.log(
  `candidates (${candidates.length}) — a mounted endpoint returning a field nothing reads:`,
);
for (const [name, count] of candidates) {
  console.log(
    `  ${name.padEnd(24)} ${String(count).padStart(2)}x  ${owner.get(name) ?? "?"}`,
  );
}
console.log("");
console.log(
  `belonging to unmounted endpoints (${unmounted.length}) — P4, not a dropped field:`,
);
for (const [name] of unmounted)
  console.log(`  ${name.padEnd(24)} ${owner.get(name)}`);
console.log("");
console.log(
  "This is a tool, not a gate: see the header for the 68-field breakdown and the",
  "three wrong versions. Run it, read the candidates, and decide by hand.",
);
