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
 * Every feature's writers, for the **writer** check only.
 *
 * The module-reachability check below stays on `GEO_ROOT` deliberately: widening
 * *that* one would flag every un-mounted surface in every feature at once, which is a
 * product decision rather than a defect list. This one asks a much narrower question —
 * "does an exported writer have a caller?" — and a false negative there is silent
 * forever, because a table nothing writes simply stays empty.
 *
 * That asymmetry is the whole argument for widening this and not the other: **a
 * missing reader is visible, a missing writer is not.**
 */
const WRITER_ROOT = "src/server/features";

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
/**
 * The import graph, resolved **once**: resolved path → the consumer files that import it.
 *
 * **This is the whole performance fix, and it changes no verdict.**
 *
 * The check asks, per declared writer: *"which consumer files import this module and
 * mention its writer?"* Written that way the gate re-derives the graph inside the writer
 * loop — reading every consumer again and calling `resolveLocal` on every local specifier
 * **once per writer**. Measured:
 *
 * | | |
 * |---|---|
 * | local import specifiers across `src` + `scripts` | 835 |
 * | writer files under `src/server/features` | 151 |
 * | **filesystem resolutions per run** | **126,085** |
 * | of which measured, as a *lower bound* | **6.8s** |
 *
 * **Every one of those 126,085 probes has the same answer as the last**, because the tree
 * does not change while the loop runs. And it is filesystem I/O specifically, which is why
 * the gate took **21s idle and 43s under load** while a regex-only replica of the same
 * check took **288ms**.
 *
 * Inverted, the question is a map lookup.
 */
function buildImportGraph(
  files: string[],
): Map<string, Array<{ file: string; source: string }>> {
  const graph = new Map<string, Array<{ file: string; source: string }>>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const specifier of importsOf(source)) {
      const resolved = resolveLocal(file, specifier);
      if (resolved === null) continue;
      const existing = graph.get(resolved);
      if (existing) existing.push({ file, source });
      else graph.set(resolved, [{ file, source }]);
    }
  }
  return graph;
}

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
/**
 * Writers with no production caller that are **intentionally** that way.
 *
 * Keyed on the **module path**, and every entry carries a reason. That is the whole design
 * of this list: **an unnamed exemption is a hole dressed as a decision**, so the type
 * makes a bare string impossible and the gate's own "exempts nothing without saying
 * why" test reads this list.
 *
 * The decision to widen this gate across every feature came with accepting that cost,
 * and this is that cost made concrete. Entries belong here only when the writer is a
 * **library** — a thing something else is meant to call — rather than a thing nothing
 * was supposed to need. "We will call it later" is not a reason; it is the bug this
 * gate exists to find.
 */
const WRITER_EXEMPT = new Map<string, string>([
  [
    // **One entry for three methods, and that is the point.** `samTurnTelemetry` has a
    // turn object whose `recordStep`, `recordToolCall` and `captureServerError` are all
    // called as **methods on an instance** — `turn.recordStep(ctx, cost)` — rather than
    // as `Namespace.member()` or a bare call. The gate sees the declaration, finds no
    // matching call shape, and reports three orphans that are wired up on the line below
    // where it looked.
    //
    // **The honest entry is the whole file with its reason**, not three bare names: a
    // list of three unexplained entries reads as three mysteries, and a list of one
    // explained entry reads as a known limitation. The limitation is real and worth
    // stating plainly — **the gate sees `foo.bar(` and `bar(`, but not `this.x.bar(` or
    // `turn.bar(`** — so every future method-on-an-instance writer lands here too.
    //
    // The alternative, teaching the gate to resolve `this.x`, is the better fix and is
    // not done yet. Until it is, this entry is what keeps the gate's hit rate honest
    // rather than perfect.
    "src/server/features/sam/samTurnTelemetry.ts",
    "Method-on-an-instance writers, called as turn.recordStep(...) rather than Namespace.member(). The gate does not resolve this.x, so these read as orphans.",
  ],
  [
    // **A different kind of exemption from the one above, and the difference matters.**
    // There the writer *is* called and the gate cannot see the call shape. Here
    // `destroyForErasure` **should not be called by this repository at all** — it is a
    // Cloudflare Durable Object lifecycle method, invoked by the runtime when an
    // erasure request reaches the object. A grep for callers will never find one, and
    // there is never meant to be one.
    //
    // Conflating the two would let the first kind grow: "the platform calls it" is
    // available for any name that sounds lifecycle-shaped, and an exemption list that
    // broad is one nobody reads.
    "src/server/features/audit/AuditScratchpad.ts",
    "A Durable Object. destroyForErasure is a lifecycle method the Cloudflare runtime invokes when an erasure request reaches the object; no caller in this repository is correct, not missing.",
  ],
]);

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
  it(
    "knows the cron-driven patrol is live, not dead",
    // **A budget, for the same reason the encoding gates have one.** This walks
    // every file under `src` and resolves every local import, which is seconds of
    // work rather than milliseconds — so under the full suite's concurrency it was
    // losing a race against vitest's 5-second default and failing with no
    // diagnostic at all. A gate that times out is worse than a gate that is red,
    // because a red gate names the module and a timeout names nothing.
    //
    // Measured at ~1.9s alone, so 20s is a wide margin rather than a number tuned
    // to pass.
    { timeout: 20_000 },
    () => {
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
    },
  );

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

  /**
   * The same reachability question, asked of **functions** rather than modules.
   *
   * `upsertAiKeywordMetrics` was exported, tested, and **called by nothing** — so
   * `ai_keyword_metrics` was never written and `getGeoAiKeywordHistory` returned an
   * empty list forever. Every check in this repository passed, because an exported
   * function *is* "used" as far as knip is concerned: **the export itself was the
   * evidence of use.**
   *
   * This asks the question a name-based sweep cannot: not "is the name mentioned"
   * but "does any production file **import** the module and call it". Namespaced
   * calls (`GeoRunRepository.insertSnapshots(...)`) resolve here and do not in a
   * grep, which is the blind spot that made the sweep's "0 orphans" a weaker claim
   * than it looked.
   *
   * **Scope: every feature, not GEO alone.** The first version walked
   * {@link GEO_ROOT} only, and this comment used to argue that was deliberate — *"widening
   * it to every feature is a larger gate that would need an exemption list"*. **The scan was
   * widened anyway** ({@link WRITER_ROOT} is `src/server/features`), and the line above
   * says the widening *is* the whole argument, so the file contradicted itself about its
   * most consequential decision.
   *
   * The exemption list it worried about turned out to be **one entry** —
   * `samTurnTelemetry`, method-on-an-instance writers the scanner cannot resolve — plus
   * `AuditScratchpad` for a Durable Object lifecycle method the platform calls. **Two
   * entries is a list someone reads**, which is the bar the old comment set and the widened
   * gate clears comfortably.
   */
  /**
   * **The negative control for the widened pattern.**
   *
   * `WRITE_NAME` gained `purge|delete|prune|remove|destroy` because
   * `purgeAiModeBefore` had no caller for the life of the repository and the pattern
   * could not see it. Widening proves nothing by itself — a pattern matching neither the
   * new cases nor the old ones passes as happily as a correct one.
   *
   * So this asserts the **scanner** finds an orphan removal writer, using the same three
   * extraction shapes as the gate below. If the verbs stop matching, this fails.
   */
  it("recognises a purge writer as a writer", () => {
    const WRITE_NAME =
      "(upsert|insert|save|record|write|capture|purge|delete|prune|remove|destroy)[A-Z]\\w*";
    const shapes: RegExp[] = [
      new RegExp(
        `export\\s+(?:async\\s+)?function\\s+(${WRITE_NAME})\\s*[(<]`,
        "g",
      ),
      new RegExp(`^\\s+(?:async\\s+)?(${WRITE_NAME})\\s*[(<]`, "gm"),
      new RegExp(`^\\s+(${WRITE_NAME})\\s*,\\s*$`, "gm"),
    ];

    // Shape 1 — a named export, which is how `purgeAiModeBefore` was declared.
    const declaration = `export async function purgeSomething(
      projectId: string,
    ): Promise<number> {
      return 0;
    }`;
    expect(
      shapes.flatMap((re) => [...declaration.matchAll(re)].map((m) => m[1])),
    ).toEqual(["purgeSomething"]);

    // Shape 3 — **shorthand, which is what every repository here actually uses**, and
    // the shape the gate's own comment records getting wrong twice.
    const shorthand = `export const Repo = {
  purgeSomethingElse,
  purgeAnother,
} as const;`;
    expect(
      shapes.flatMap((re) => [...shorthand.matchAll(re)].map((m) => m[1])),
    ).toEqual(["purgeSomethingElse", "purgeAnother"]);

    // **And a helper that merely starts with a removal verb must not match**, or the
    // widening starts reporting every `removeFormatting` in the codebase.
    const notAWriter = `function removeFormatting(text: string) {
      return text;
    }`;
    expect(
      shapes.flatMap((re) => [...notAWriter.matchAll(re)].map((m) => m[1])),
    ).toEqual([]);
  });
  it(
    "reports no feature writer whose only callers are tests",
    /**
     * **30s, measured rather than guessed.** This walks every GEO file, extracts
     * three declaration shapes from each, then for every declared writer re-reads
     * every consumer file — a reader × writer scan. It runs at **~9.5s** against
     * vitest's 5s `testTimeout` and 10s `hookTimeout`, so it would have been the
     * next flake in this suite for exactly the reason `oauth-refresh` was the last
     * one: a slow check whose failure names nothing.
     *
     * **
     * 20s, and that is down from 60s — because the redundancy was removed, not because the
     * ceiling was raised.** The scan had widened to every feature and the cost had moved into
     * filesystem I/O: the gate re-resolved the import graph **once per declared writer**,
     * which is 126,085 `resolveLocal` probes for answers that cannot change during the loop.
     *
     * | | before | after |
     * |---|---|---|
     * | the writer scan | 18.2s | 0.4s |
     * | the test | 21s idle, 43s under load | **1.5s** |
     * | budget | 60s, 72% consumed under load | 20s, **7.5%** |
     *
     * **Both implementations were run over the real tree and compared name for name** —
     * identical verdicts, 45x apart — because a faster gate that checks less is the worst
     * outcome available here and it would look like a pure win.
     *
     * The original reasoning stands: **a timeout reports nothing at all**, so it is the last
     * response, not the first. The first is to find the slowness.
     */
    { timeout: 20_000 },
    () => {
      // **Three shapes**, because each version of this found fewer writers than the last
      // and the guard caught every one. The repository convention is
      // `export const GeoRunRepository = { …, upsertAiKeywordMetrics, … } as const`
      // — **shorthand**, a bare name with no parentheses at all, so the `(` and `<`
      // in the method pattern below match nothing here.
      //
      // All three wrong versions shared one cause: writing the pattern for the shape
      // I had seen most recently rather than the shape in front of me. That is why
      // `expect(checked).toBeGreaterThan(5)` is here — it fired with `expected 1 to be
      // greater than 5` twice, and named the bug each time instead of reporting a
      // clean bill of health.
      /**
       * **`purge`, `delete` and `prune` are writers too** — they remove rows, and a
       * removal that is never called leaves a table growing without bound.
       *
       * `purgeAiModeBefore` existed, was tested, and had no caller anywhere in the
       * repository, so `ai_mode_snapshots` — the verbatim answer markdown, the largest
       * table in the schema — grew while the retention sweep that exists to prevent
       * exactly that reported success every night. **This pattern could not see it**,
       * which is what made it a lasting bug rather than an unlucky one: a writer gate
       * that cannot fail on the class it exists to catch is worse than no gate, because
       * it looks authoritative.
       */
      const WRITE_NAME =
        "(upsert|insert|save|record|write|capture|purge|delete|prune|remove|destroy)[A-Z]\\w*";
      const shapes: RegExp[] = [
        // 1. `export async function upsertFoo(`
        new RegExp(
          `export\\s+(?:async\\s+)?function\\s+(${WRITE_NAME})\\s*[(<]`,
          "g",
        ),
        // 2. `  async upsertFoo(` — a method with a body.
        new RegExp(`^\\s+(?:async\\s+)?(${WRITE_NAME})\\s*[(<]`, "gm"),
        // 3. `  upsertFoo,` — **shorthand**, which is what every repository here uses.
        new RegExp(`^\\s+(${WRITE_NAME})\\s*,\\s*$`, "gm"),
      ];

      const offenders: string[] = [];
      let checked = 0;

      // **Paid once, before the writer loop.** Every consumer is read here and its local
      // specifiers resolved — once — rather than `writers x consumers` times inside it.
      const importGraph = buildImportGraph(consumerFiles);

      for (const file of walk(join(ROOT, WRITER_ROOT))) {
        const rel = relative(ROOT, file).replace(/\\/g, "/");
        if (/\.test\.tsx?$/.test(rel)) continue;
        const src = readFileSync(file, "utf8");

        const declared = shapes.flatMap((re) =>
          [...src.matchAll(re)].map((m) => m[1]),
        );

        for (const name of declared) {
          checked += 1;

          // A **call**, not a mention: `name(` on a line that is not a comment.
          // The comment case is the exact trap — `upsertAiKeywordMetrics` appears in
          // its own file's prose, and a sweep that counted words found it "used".
          //
          // **Or a bare reference.** `scheduledAiKeywordCapture` injects its writer
          // as `?? GeoRunRepository.upsertAiKeywordMetrics` — a method reference,
          // not a call — so a pattern requiring `(` reported a wired-up writer as
          // an orphan. A dependency injected for testability is still a
          // dependency, and **the gate was wrong rather than the code**.
          //
          // **No trailing character requirement at all.** Requiring `.` or `(` after
          // the name looks right and is wrong twice: the reference above sits at the
          // *end* of its line, so `upsertAiKeywordMetrics;` has no punctuation after
          // it at all — and requiring one would also miss a writer named in a
          // `typeof` position. So the rule is "the name appears in a non-comment line
          // of a file that imports this module", which is what a reference *is*.
          //
          // The comment exclusion is what keeps this honest: the name appears in this
          // repository's own prose in three files, and counting those would report
          // every writer as wired.
          const isCalled = (source: string): boolean =>
            source.split(/\r?\n/).some((line) => {
              const t = line.trim();
              if (
                t.startsWith("//") ||
                t.startsWith("*") ||
                t.startsWith("/*")
              ) {
                return false;
              }
              return line.includes(name);
            });

          // Only counts as a caller if it also **imports this module** — otherwise a
          // same-named function in an unrelated file would vouch for this one.
          // **One map lookup, not a filter over 1114 files.** `importGraph` was built
          // once above; the old shape re-read every consumer and re-resolved every
          // local specifier **inside this loop**, which is where the 21 seconds went.
          const importers = (importGraph.get(file) ?? []).filter(
            ({ file: f, source }) => {
              if (f === file) return false;
              const grel = relative(ROOT, f).replace(/\\/g, "/");
              if (/\.test\.tsx?$/.test(grel)) return false;
              return isCalled(source);
            },
          );

          if (importers.length > 0) continue;
          // **The exemption is a keyed lookup, not a scan of a comment.** The
          // decision was to accept a list, so the list has to be the honest kind:
          // every entry names a module and says why. An unnamed entry is a hole
          // dressed as a decision.
          // **Keyed on the module alone, deliberately.** A whole file shares one
          // reason — three methods on one turn object are one fact, not three — so
          // keying on `module#writer` would force the same sentence three times, and a
          // list of three copies is a list nobody maintains.
          if (WRITER_EXEMPT.has(rel)) continue;
          offenders.push(`${name}  —  ${rel}`);
        }
      }

      // **A non-zero count, so a mis-scoped walk is not green.** Without it, a
      // misspelled root yields zero writers and the gate passes having checked
      // nothing — the failure mode of the first two versions of the casing gate.
      expect(checked).toBeGreaterThan(5);
      expect(offenders).toEqual([]);
    },
  );

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
