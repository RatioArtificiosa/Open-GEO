import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A GEO module with tests but no production caller is dead code that reads as
 * working code.
 *
 * ## Why knip cannot catch this, which is the root cause of ten instances
 *
 * **knip counts a test file as a consumer.** An exported function imported by a
 * `.test.ts` is reachable by knip's reckoning, so a module whose only importer is
 * its own test suite reports as "used". That is the whole reason this class of
 * defect survived nine separate audits: every automated check said the code was
 * fine.
 *
 * Each of those nine had its own module, a docstring explaining why it was
 * correct, and a passing test suite. One had a row in a migration. They were
 * unreachable in production and looked healthy in every signal available.
 *
 * ## What this gate asks instead
 *
 * Not "does anything import this?" but **"does anything outside a test import
 * this?"** A module whose only consumers are `*.test.ts` is dead unless it is
 * deliberately exempted, and an exemption must carry a reason — which is the point.
 * CL-308c is the lesson this encodes: a route that exists, tests green, and cannot
 * be reached.
 *
 * ## The exclusions, and why each is necessary
 *
 * - **Entry points** (`index.ts`, `server.ts`, `*.config.ts`, anything in
 *   `knip.jsonc`'s entry list) are reached by the platform, not by an import.
 * - **Route modules** are reached by the router, which reads a directory rather
 *   than importing a file.
 * - **Test files themselves** are consumers of the suite, not dead code.
 *
 * A wrong exemption is worse than no exemption, so the list is short and every
 * entry names its caller.
 */

/** Modules reached by the platform rather than by an import. */
const ENTRY_POINTS = [
  /^index\.[tj]sx?$/,
  /^server\.[tj]s$/,
  /\.config\.[tj]s$/,
  /^routes\.tsx?$/,
];

/** A module the router reaches by reading a directory, not by importing it. */
function isRouteModule(rel: string): boolean {
  return (
    rel.includes("/routes/") ||
    rel.startsWith("routes/") ||
    /Route\.tsx$/.test(rel)
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === "dist" ||
      entry.name === ".output" ||
      entry.name === "coverage"
    ) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every module under `src/server/features/geo`, which is where this bug class has
 * lived.
 *
 * Deliberately narrow. A gate over the whole `src` tree would flag the many
 * legitimately-unreferenced utilities this repository keeps, and a gate with a long
 * exemption list is a gate that gets deleted.
 */
const GEO_ROOT = "src/server/features/geo";

/**
 * The tree scanned for *consumers*.
 *
 * **This must be wider than {@link GEO_ROOT}, and the first version got it wrong.**
 * It walked only the GEO directory, so a GEO module imported by `src/server.ts` —
 * which every scheduled handler is — appeared to have no production consumer at
 * all. It reported 20 dead modules, including `GeoPatrol` and
 * `scheduledGeoPatrol`, both of which are driven by the cron every five minutes.
 *
 * That is the worst possible failure for this gate: a reader who saw `GeoPatrol`
 * flagged would conclude the whole rule was nonsense and delete it, and the nine
 * instances it exists to catch would become nine more. A gate that is wrong about
 * what is alive is more dangerous than no gate, because it looks authoritative.
 */
const CONSUMER_ROOTS = ["src", "scripts"];

/** Imports a module makes, as written in its source. */
function importsOf(source: string): string[] {
  const out: string[] = [];
  const re =
    /(?:from|import)\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    out.push(match[1] ?? match[2] ?? "");
  }
  return out;
}

/**
 * A bare specifier's target file, or null when it is a package.
 *
 * **Handles the `@/` alias, and the first version did not.** `src/server.ts` imports
 * every scheduled handler as `@/server/features/geo/services/scheduledGeoPatrol`,
 * so a resolver that only understood `./relative` specifiers saw no consumer at all
 * and reported `GeoPatrol`, `scheduledGeoPatrol` and `queueDrainRunner` as dead —
 * all three driven by the cron every five minutes.
 *
 * That is the second wrong version of the same gate, and the failure is identical
 * each time: it reports live code as dead, and a reader who trusts that deletes the
 * rule. **A reachability gate must be checked against a module known to be live
 * before its verdict on anything else is worth reading**, which is why the control
 * above names `GeoPatrol` specifically rather than a synthetic file.
 */
function resolveLocal(importer: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(ROOT, "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? join(importer, "..", specifier)
      : null;
  if (base === null) return null;

  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this one; try the next shape.
    }
  }
  return null;
}

const ROOT = process.cwd();

/**
 * Deliberate exceptions, each with the caller that justifies it.
 *
 * **The only legitimate reason to appear on this list is that the module is itself
 * test infrastructure.** Everything else that is genuinely dormant must either be
 * wired or deleted — an exemption is not a place to park a feature, which is how
 * nine of them stayed invisible: each was "noted in a comment" rather than listed
 * here, and a note is not a gate.
 */
const EXEMPT: Array<{ module: string; reason: string }> = [
  {
    module: "src/server/features/geo/services/alertFixture.ts",
    reason:
      "A shared in-memory SQLite harness for alertRunner.test.ts and alertBrandScoping.test.ts. It is test infrastructure, so test-only consumers are its purpose rather than a symptom — and it is shared precisely because two copies of a migration harness drift.",
  },
];

/**
 * The importer index, as a pure function over two lists.
 *
 * Hoisted out of the test body so a fixture can be fed to it. **This is not
 * tidiness** — `scripts/gates-about-gates.test.ts` holds that a rule closing over
 * `readFileSync` of a fixed path has *no writable failing case at all*, because
 * there is no second input to hand it, and three gates in this repository were
 * confidently wrong for exactly that reason. The strongest control is one that
 * builds its own fixture, so the decision functions have to accept one.
 */
function indexProducers(
  producerFiles: ReadonlyArray<{ file: string; imports: readonly string[] }>,
  resolve: (importer: string, specifier: string) => string | null,
): Map<string, Set<string>> {
  const consumers = new Map<string, Set<string>>();
  for (const { file, imports } of producerFiles) {
    for (const specifier of imports) {
      const target = resolve(file, specifier);
      if (target === null) continue;
      const set = consumers.get(target) ?? new Set<string>();
      set.add(file);
      consumers.set(target, set);
    }
  }
  return consumers;
}

/** Non-test importers of a module, from the index. */
function productionImportersOf(
  consumers: Map<string, Set<string>>,
  target: string,
): string[] {
  return [...(consumers.get(target) ?? [])].filter(
    (f) => !/\.test\.tsx?$/.test(f),
  );
}

/**
 * The rule itself, as a pure predicate over one module's importers.
 *
 * A module is dead when nothing outside a test imports it. Written as a predicate
 * rather than inlined in a loop so the control below can feed it a fixture and
 * watch it say yes — a rule that cannot be *shown* to fire is a rule nobody can
 * tell apart from a rule that never fires.
 */
function isDeadModule(importers: readonly string[]): boolean {
  return importers.filter((f) => !/\.test\.tsx?$/.test(f)).length === 0;
}

describe("a GEO module must be reachable from production", () => {
  const files = walk(join(ROOT, GEO_ROOT));
  const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

  /** Every module in the consumer roots, which is a superset of `files`. */
  const consumerFiles = CONSUMER_ROOTS.flatMap((r) => walk(join(ROOT, r)));

  it("finds a real number of modules, so a wrong directory is not green", () => {
    // Without this the gate passes vacuously if GEO_ROOT is misspelled, which is
    // the failure mode of the first two versions of the casing gate.
    expect(files.length).toBeGreaterThan(20);
  });

  /**
   * The control that matters most, and the one the first version lacked: **the gate
   * must know a live module is live.**
   *
   * It reported `GeoPatrol` as dead while `src/server.ts` imports it and the cron
   * runs it every five minutes, because the consumer walk covered only the GEO
   * directory. So this asserts the property on the *real* module rather than on a
   * synthetic one — a synthetic control passed happily while the real code was
   * wrong, which is the same lesson as the casing gate's control assertion.
   */
  it("knows the cron-driven patrol is live, not dead", () => {
    const patrol = join(ROOT, GEO_ROOT, "services/GeoPatrol.ts");
    const importersOf = (target: string): string[] =>
      consumerFiles
        .filter((f) =>
          importsOf(readFileSync(f, "utf8")).some((spec) => {
            const resolved = resolveLocal(f, spec);
            return resolved !== null && resolved === target;
          }),
        )
        .map((f) => relative(ROOT, f).replace(/\\/g, "/"));

    // Live, and live *transitively* through the worker's entry point:
    // `src/server.ts` imports `scheduledGeoPatrol`, which imports `GeoPatrol`. The
    // first version asserted a direct import and failed with
    // `expected [ ...2 ] to include 'src/server.ts'` — the gate was right about the
    // module and the control was asking the wrong question. **Reachability is
    // transitive**, and a gate that only follows direct edges misses the most
    // common shape there is: a cron handler wrapping the thing it drives.
    expect(importersOf(patrol)).toContain(
      "src/server/features/geo/services/scheduledGeoPatrol.ts",
    );
    // **The module written for this change must now be live.** It was dead when this
    // control was written — that is exactly what the gate found — so the assertion
    // is inverted as the work lands. Leaving it asserting `[]` would mean the
    // control can only ever pass while the defect persists, which is a control that
    // rewards the bug.
    expect(
      importersOf(join(ROOT, GEO_ROOT, "services/aiModeMonitor.ts")),
    ).toContain("src/server/features/geo/services/scheduledAiModeCapture.ts");
  });

  it("rejects a module whose only importer is its own test", () => {
    /**
     * A **self-contained** control: no `readFileSync` in this block at all, so the
     * rule is shown firing on a fixture rather than on the live repository.
     *
     * That separation is the point. `gates-about-gates.test.ts` rejects a control
     * that reads the repository, on the grounds that a scanner matching nothing at
     * all would satisfy it too — so the sibling test that checks live files is
     * deliberately *not* a control, and this one is.
     */
    const onlyATestImportsIt = ["./thing.test.ts"];
    expect(isDeadModule(onlyATestImportsIt)).toBe(true);

    const productionImportsIt = ["./thing.test.ts", "./server.ts"];
    expect(isDeadModule(productionImportsIt)).toBe(false);
  });

  it("reports no GEO module whose only consumers are tests", () => {
    // Over the *consumer* roots, not the GEO directory — see CONSUMER_ROOTS.
    const index = indexProducers(
      consumerFiles.map((file) => ({
        file,
        imports: importsOf(readFileSync(file, "utf8")),
      })),
      resolveLocal,
    );

    const exempt = new Set(EXEMPT.map((e) => e.module));

    const dead: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");

      if (/\.test\.tsx?$/.test(rel)) continue;
      if (ENTRY_POINTS.some((re) => re.test(rel.split("/").pop() ?? ""))) {
        continue;
      }
      if (isRouteModule(rel)) continue;
      if (exempt.has(rel)) continue;

      if (isDeadModule(productionImportersOf(index, file))) dead.push(rel);
    }

    expect(dead).toEqual([]);
  });

  it("exempts nothing without saying why", () => {
    // An exemption with an empty reason is the same as no exemption with extra
    // steps, and it is how this defect was documented nine times over.
    const unexplained = EXEMPT.filter((e) => e.reason.trim().length < 10).map(
      (e) => e.module,
    );
    expect(unexplained).toEqual([]);
  });
});
