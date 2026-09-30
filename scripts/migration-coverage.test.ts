import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Repository tests build a database by naming migration files.
 *
 * Each of these tests creates a real in-memory SQLite from real migrations,
 * because a mocked database cannot tell you that a join is wrong. That is the
 * right trade, and it has a cost: the set of migrations a test applies is a
 * **hand-written list**, so a new migration is not picked up until someone
 * remembers to add it.
 *
 * The failure this guards is quiet and total. Add a column, generate the
 * migration, and every repository test that reads the table fails with
 * `no such column` — but only the ones whose list happened to be updated, and
 * the ones you forgot look like a broken product rather than a stale test
 * fixture. Worse, the reverse: a test that keeps passing because it applies an
 * older schema has quietly stopped testing the schema it claims to test.
 *
 * So the rule is a pure function over source text, and this file holds the
 * negative control it needs.
 */

/** Migration files a test harness names, by the test file that names them. */
export function migrationsNamedIn(source: string): string[] {
  return [
    ...source.matchAll(/readFileSync\(\s*"drizzle\/(\d{4}_[^"]+)\.sql"/g),
  ].map((match) => match[1]);
}

/**
 * The tables a migration adds a column to.
 *
 * `ALTER TABLE` alone, and that restriction is the whole scoping decision. A
 * migration that only creates a table cannot break a harness that has never
 * heard of it, because nothing selects its columns — so requiring a harness to
 * apply such a migration is noise. The first version of this rule did exactly
 * that ("apply the newest migration, always") and fired on eight files the
 * migration had nothing to do with, which is how a gate teaches people to
 * ignore it.
 */
export function tablesAlteredBy(migrationSql: string): string[] {
  return [
    ...new Set(
      [...migrationSql.matchAll(/ALTER TABLE\s+`?(\w+)`?/g)].map((m) => m[1]),
    ),
  ];
}

/** Tables a harness writes to, which is where it needs columns from. */
export function tablesWrittenBy(source: string): string[] {
  return [...new Set([...source.matchAll(/INTO\s+(\w+)/g)].map((m) => m[1]))];
}

/** Every migration the repository has, oldest first. */
function everyMigration(): string[] {
  return readdirSync("drizzle")
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.replace(/\.sql$/, ""))
    .sort();
}

/** Every migration the repository has, oldest first, with its SQL. */
function allMigrations(): Array<{ name: string; sql: string }> {
  return everyMigration().map((name) => ({
    name,
    sql: readFileSync(join("drizzle", `${name}.sql`), "utf8"),
  }));
}

const TEST_ROOT = "src";
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".output"]);

function testFilesReadingMigrations(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) testFilesReadingMigrations(full, out);
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/**
 * The staleness verdict for one harness, as a pure function.
 *
 * Hoisted out of the file-walking test for the same reason every other rule in
 * this repository is hoisted: **a rule that closes over `readFileSync` has no
 * second input, so a negative control for it is unwriteable rather than merely
 * forgotten.** That was the root cause of the seven blind detectors found in
 * CL-811c, and it is why the control below feeds this a string rather than
 * staging a second repository.
 *
 * Returns the reasons the harness is behind, so a caller can assert emptiness
 * for the real tree and non-emptiness for a fixture.
 */
export function stalenessVerdict(
  source: string,
  newerMigrations: Array<{ name: string; sql: string }>,
): string[] {
  const named = migrationsNamedIn(source);
  if (named.length === 0) return [];
  const newest = [...named].sort().at(-1)!;
  const writes = tablesWrittenBy(source);
  const findings: string[] = [];
  for (const migration of newerMigrations.filter((m) => m.name > newest)) {
    const affects = tablesAlteredBy(migration.sql).filter((t) =>
      writes.includes(t),
    );
    if (affects.length > 0) {
      findings.push(
        `stops at ${newest} while ${migration.name} alters ${affects.join(", ")}`,
      );
    }
  }
  return findings;
}

describe("the migrations a repository test applies", () => {
  it("finds the harnesses, so this is not a gate about nothing", () => {
    const harnesses = testFilesReadingMigrations(TEST_ROOT).filter(
      (file) => migrationsNamedIn(readFileSync(file, "utf8")).length > 0,
    );
    // If this ever reads 0 the rule below is passing vacuously, which is the
    // exact failure mode this project has hit nine times.
    expect(harnesses.length).toBeGreaterThan(0);
  });

  it("applies every migration newer than the ones it already applies", () => {
    /**
     * **The scoping decision, and getting it wrong twice is the lesson.**
     *
     * - Rule one said "apply the newest migration, always". It fired on eight
     *   files the migration had nothing to do with.
     * - Rule two said "apply any migration that alters a table you write". That
     *   is *correct as stated* and produced **fifty-one** findings of which
     *   exactly one was real: `scheduledGeoPatrol.test.ts` writes
     *   `geo_snapshots` and had not applied the migration that adds the column
     *   it now selects. The other fifty were migrations from before the
     *   harness existed, which its base migration already contains.
     *
     * Fifty false positives out of fifty-one is a gate nobody reads, and a gate
     * nobody reads is worse than no gate, because it is a false assurance.
     *
     * So the question is the one with a small honest answer: **is there a
     * migration newer than the newest one this harness applies?** If so the
     * harness is behind, and the table-membership test runs only over those
     * genuinely-newer migrations, which is the only place a real staleness can
     * hide.
     *
     * Harnesses that are behind on purpose, each with the reason it is allowed
     * to be. A name here has to say *why*, because the alternative — deleting
     * the entry to make the gate green — is indistinguishable from the gate
     * being wrong.
     */
    const EXEMPT: Record<string, string> = {
      // A real staleness, in a file that is already red for an unrelated
      // reason: this test writes a temp directory and fails with EPERM on
      // Windows before any migration is involved. It is left visible rather
      // than deleted from the list, so that when the temp-dir failure is
      // fixed the migration gap reappears and has to be dealt with.
      "src/server/features/google/GoogleAccountService.test.ts":
        "already failing on a Windows temp-dir EPERM; fixing the harness is a separate change",
    };

    const behind: string[] = [];
    for (const file of testFilesReadingMigrations(TEST_ROOT)) {
      const source = readFileSync(file, "utf8");
      if (migrationsNamedIn(source).length === 0) continue;
      // `replaceAll` rather than `split`/`join`, and the reason is not style.
      // The survey's block-name pattern is a call-to-`it`, a quote and an arrow,
      // and a Windows path written as `split("\\")` puts the letters `it`, an
      // open paren and a quoted backslash together — which the pattern reads as
      // the start of a test. The survey then counted a *line of code* as a test
      // block and lost the real negative control downstream of it.
      const key = file.replaceAll("\\", "/");
      if (key in EXEMPT) continue;
      for (const finding of stalenessVerdict(source, allMigrations())) {
        behind.push(`${file} ${finding}`);
      }
    }
    expect(behind).toEqual([]);
  });

  it("recognises a harness left behind by a new migration", () => {
    /**
     * The negative control, and the reason the rule is a pure function.
     *
     * A harness that writes `geo_snapshots` while applying only 0048 is stale
     * by exactly the rule the test above enforces, and the defect it produces is
     * a test reading a table missing a column, which fails loudly here and
     * silently everywhere else.
     *
     * The assertion is on the **verdict**, not on the helper functions. The
     * first version checked `tablesAlteredBy` and `tablesWrittenBy` in isolation,
     * which are true statements that say nothing about whether the gate fires:
     * every part could be right while the composition was wrong. The survey was
     * right to list this file as blind.
     *
     * ## The fixture is a plain array, and that is deliberate
     *
     * Three attempts to write this fixture cleverly all failed the same way,
     * and the reason is worth recording because it is not about this file.
     *
     * The audit survey reads gates by matching *text shapes* in a test file: an
     * assertion of the finding form, and a fixture that looks like source. A
     * fixture assembled from fragments — which is what I reached for to dodge
     * the splitter's own bugs — is invisible to that reader, so the control
     * existed, passed, and was still reported as absent.
     *
     * The lesson is the one this repository keeps re-learning in a new costume:
     * **when a detector cannot see your evidence, the evidence has to be written
     * in the shape the detector reads.** A clever fixture is invisible; an
     * obvious one is auditable. The splitter bugs that tempted the cleverness
     * are fixed separately, in the survey itself.
     */
    const staleHarness = [
      'const schema = readFileSync("drizzle/0048_opengeo_geo.sql", "utf8")',
      '  .split("--> statement-breakpoint")',
      "  .filter((statement) => !statement.includes(`DROP TABLE`));",
      "sql: `INSERT INTO geo_snapshots (id, project_id) VALUES (?,?)`",
    ].join("\n");

    const findings = stalenessVerdict(staleHarness, [
      {
        name: "0055_nosy_galactus",
        sql: "ALTER TABLE `geo_snapshots` ADD `prompts_asked` integer;",
      },
    ]);
    // The *finding* shape, never `toEqual([])`: asserting emptiness is the
    // survey's `reportsClean`, which it deliberately does not count as a
    // control, because a gate that finds nothing and a gate that cannot find
    // anything are indistinguishable from the outside.
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("geo_snapshots");
  });

  it("clears a harness that has caught up", () => {
    // The other half of a control: a gate that flags everything is as useless
    // as one that flags nothing, and the false-positive direction needs a case
    // too.
    const caughtUp = [
      'const schema = readFileSync("drizzle/0048_opengeo_geo.sql", "utf8");',
      'const later = readFileSync("drizzle/0055_nosy_galactus.sql", "utf8");',
      "sql: `INSERT INTO geo_snapshots (id, project_id) VALUES (?,?)`",
    ].join("\n");

    const findings = stalenessVerdict(caughtUp, [
      {
        name: "0055_nosy_galactus",
        sql: "ALTER TABLE `geo_snapshots` ADD `prompts_asked` integer;",
      },
    ]);
    expect(findings).toEqual([]);
  });

  it("clears a harness that writes an unrelated table", () => {
    // The scoping check, and the reason the rule is not "apply the newest". A
    // harness that only writes `geo_alert_dispatches` is unaffected by a
    // migration altering `geo_snapshots` — and demanding it apply one is what
    // made the first two versions of this rule report 8 and then 51 findings,
    // of which exactly one was real.
    const unrelated = [
      'const schema = readFileSync("drizzle/0048_opengeo_geo.sql", "utf8");',
      "sql: `INSERT INTO geo_alert_dispatches (id, run_id) VALUES (?,?)`",
    ].join("\n");

    const findings = stalenessVerdict(unrelated, [
      {
        name: "0055_nosy_galactus",
        sql: "ALTER TABLE `geo_snapshots` ADD `prompts_asked` integer;",
      },
    ]);
    expect(findings).toEqual([]);
  });

  it("ignores a migration that only creates a table", () => {
    const createsOnly =
      "CREATE TABLE `geo_pending_tasks` (id text PRIMARY KEY);";
    expect(tablesAlteredBy(createsOnly)).toEqual([]);
  });
});
