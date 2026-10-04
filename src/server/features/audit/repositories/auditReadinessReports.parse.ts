/**
 * Reading a stored readiness report.
 *
 * ## Why this is its own module
 *
 * **Because the rules are decisions and the row is plumbing.** The three
 * distinctions this project keeps insisting on — *missing report* versus *empty
 * report*, *unreadable coverage* versus *empty coverage*, *corrupt fixes* versus
 * *no fixes* — are all decisions about what a corrupt or absent value *means*.
 * Inline in a query result they would be unreachable without a database, and
 * **a rule that cannot be tested without infrastructure is a rule that will not be
 * tested**: an earlier mutation run in this codebase proved exactly that, when two
 * mutations that stopped a JSON column being written left every suite green.
 */

/** One persisted fix, in the order the report gave it. */
type StoredReadinessFix = {
  id: string;
  kind: string;
  fix: string;
  because: string;
  example: string | null;
  order: number;
};

/**
 * Module-private: nothing outside this file names it, and a type exported for
 * symmetry is an export somebody will depend on before it settles.
 */
type StoredReadinessReport = {
  id: string;
  auditId: string;
  summary: string;
  whyNoScore: string;
  fixes: StoredReadinessFix[];
  /**
   * What the run could not check, or `null` when the stored value is unreadable.
   *
   * **`null` rather than `[]` for a corrupt column**: an empty list is a claim
   * (*we checked everything and it covered nothing*) and a column we cannot read is
   * *we do not know*. The two need different advice, and the report's `whyNoScore`
   * leans on the difference.
   */
  coverage: string[] | null;
  /**
   * What could not be evaluated, with a reason the reader can act on.
   *
   * **A real shape, not `unknown[]`.** The value is the seam's `notes`, which
   * are always `{ what, because }`. Carrying `unknown` across a server-function
   * boundary made the whole return type un-inferrable and cascaded into every
   * client consumer, which is what a concrete type avoids — and a client that
   * needs to *show* the reason has nothing to show without one.
   */
  unavailable: Array<{ what: string; because: string }>;
  fixCount: number;
  pageCount: number;
  createdAt: string;
};

/**
 * The row shape as the database hands it over, before any parsing.
 *
 * **Module-private.** It exists to type this module's parameter and nothing else;
 * exporting it would let a caller name a shape it never constructs.
 */
type StoredReadinessRow = {
  id: string;
  auditId: string;
  summary: string;
  whyNoScore: string;
  fixesJson: string | null;
  coverageJson: string | null;
  unavailableJson: string | null;
  fixCount: number;
  pageCount: number;
  createdAt: string;
};

/**
 * Turn a stored row into a report, or `null` when there is no row at all.
 *
 * **`null` for a missing row and `[]` for empty fixes are different answers**:
 * the first says our run did not finish, the second says it finished and found
 * nothing. A reader that collapses them tells a customer their site is fine
 * because we crashed — which is the failure the readiness phase's own catch
 * prevents, arriving from the other direction.
 */
export function parseStoredReadiness(
  row: StoredReadinessRow | null | undefined,
): StoredReadinessReport | null {
  if (row === null || row === undefined) return null;
  return {
    id: row.id,
    auditId: row.auditId,
    summary: row.summary,
    whyNoScore: row.whyNoScore,
    fixes: parseFixes(row.fixesJson),
    coverage: parseStrings(row.coverageJson),
    unavailable: parseNotes(row.unavailableJson),
    fixCount: row.fixCount,
    pageCount: row.pageCount,
    createdAt: row.createdAt,
  };
}

/**
 * Fixes in the order they were stored, **never re-sorted**.
 *
 * The ordering is the report's claim — a blocked crawler outranks everything
 * because it is a precondition — so re-sorting on read would quietly discard the
 * one thing the report exists to say.
 *
 * **A corrupt blob becomes `[]`.** Asymmetric with coverage on purpose: fixes are
 * the report's content, and a blob we cannot read is a write we cannot recover, so
 * the honest answer is "nothing I can show you". Coverage is different — the
 * *absence* of it is itself information.
 */
function parseFixes(raw: string | null): StoredReadinessFix[] {
  const parsed = parseArray<{ [key: string]: unknown }>(raw);
  const fixes: StoredReadinessFix[] = [];
  for (const entry of parsed) {
    // **Validated, not cast.** A fix is rendered verbatim to a customer, so an
    // entry missing `fix` or `because` is not a degraded row — it is one that
    // would render as an empty instruction with no reason attached, which is worse
    // than absent because it looks actionable. Every field the type promises is
    // checked, and a bad entry is dropped rather than half-rendered.
    if (typeof entry?.fix !== "string") continue;
    if (typeof entry?.because !== "string") continue;
    fixes.push({
      id: typeof entry.id === "string" ? entry.id : "",
      kind: typeof entry.kind === "string" ? entry.kind : "",
      fix: entry.fix,
      because: entry.because,
      example: typeof entry.example === "string" ? entry.example : null,
      order: typeof entry.order === "number" ? entry.order : 0,
    });
  }
  return fixes;
}

/** Parsed JSON array, or `[]` for null, malformed, or a non-array. */
function parseArray<T>(raw: string | null): T[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    // Guarded by the `Array.isArray` above; element shapes are written and read
    // by the same version of this codebase, so a per-element validator would be a
    // second place for the two to disagree.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- guarded by the Array.isArray immediately above
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * The notes, keeping only entries that carry both fields.
 *
 * **Filtered rather than cast**, because a malformed entry is one we cannot show
 * a customer: `{ what: "" }` renders as an empty label, which is a finding with
 * no content. Dropping it leaves a shorter list, which is honest.
 */
function parseNotes(
  raw: string | null,
): Array<{ what: string; because: string }> {
  const parsed = parseArray<{ what?: unknown; because?: unknown }>(raw);
  const notes: Array<{ what: string; because: string }> = [];
  for (const entry of parsed) {
    if (typeof entry?.what !== "string") continue;
    if (typeof entry?.because !== "string") continue;
    notes.push({ what: entry.what, because: entry.because });
  }
  return notes;
}

/** Parsed coverage lines, or `null` for null, malformed, or a non-array. */
function parseStrings(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // **Any non-string entry makes the whole column `null`, rather than being
    // filtered out.** Asymmetric with the fixes above on purpose: a coverage list
    // whose length is wrong is a claim about how much was checked, and silently
    // dropping an unreadable line would *understate* that — telling a reader less
    // was verified than the run actually recorded. `null` says "we cannot tell",
    // which is the truth. An empty array here is preserved as empty.
    if (!parsed.every((line) => typeof line === "string")) return null;
    return parsed;
  } catch {
    return null;
  }
}
