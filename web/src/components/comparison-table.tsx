type Tone = "positive" | "negative" | "neutral";

export type Cell = {
  text: string;
  tone?: Tone;
  code?: boolean;
  /**
   * A link on the cell — a comparison row that sends the reader to the source is
   * what makes it checkable rather than assertive. **Required in practice** on
   * every row where the claim is checkable, because "we are better" is a claim
   * and "here is the evidence" is the difference between the two.
   */
  href?: string;
};

export type Column = {
  /** Vendor name as the reader would search for it — used for `key` and for the
   *  mobile per-cell label, so it must be the plain name, not a shortened one. */
  name: string;
  /** One line on who they are, so the table is not a wall of logos. */
  blurb?: string;
  href?: string;
  /**
   * Whether this column is ours. **The component renders no preference of its
   * own**: which column is highlighted is the page's decision, not the table's,
   * because a table that assumes it is winning is the thing this page exists
   * against.
   */
  ours?: boolean;
};

export type ComparisonRow = {
  label: string;
  cells: Cell[];
};

export function ComparisonTable({
  columns,
  rows,
  caption,
}: {
  columns: Column[];
  rows: ComparisonRow[];
  /** Required. A table with no caption is a table a screen reader cannot name. */
  caption: string;
}) {
  // **A cell count that does not match the header is a data bug, not a layout
  // one**, so it throws here rather than rendering a ragged row that a reader
  // silently reads as "nothing to report".
  for (const row of rows) {
    if (row.cells.length !== columns.length) {
      throw new Error(
        `Comparison row "${row.label}" has ${row.cells.length} cells but there are ${columns.length} columns`,
      );
    }
  }

  return (
    <div className="not-prose my-8">
      {/* The table element, so a screen reader announces it as a table with the
          right column and row counts. The card treatment is on a wrapper, never
          on the <table>, because a scroll container inside one breaks that. */}
      <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-white">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">{caption}</caption>

          {/* Desktop and tablet: a real grid. Min-width is deliberately absent,
              because a min-width is what turns a five-column table into a
              horizontal scroll on a phone — and a scrolled comparison shows the
              reader only the column that flatters us. */}
          <thead className="hidden md:table-header-group">
            <tr>
              <th
                scope="col"
                className="w-[18%] p-4 align-bottom text-sm font-medium text-[var(--color-brand-muted)]"
              >
                <span className="sr-only">Capability</span>
              </th>
              {columns.map((col) => (
                <th
                  key={col.name}
                  scope="col"
                  className={`p-4 align-bottom ${
                    col.ours
                      ? "border-x border-[var(--color-border-subtle)] bg-[var(--color-surface-sunken)]"
                      : ""
                  }`}
                >
                  <span
                    className={`block text-sm font-semibold ${
                      col.ours ? "text-neutral-950" : "text-neutral-900"
                    }`}
                  >
                    {col.name}
                  </span>
                  {col.blurb ? (
                    <span className="mt-1 block text-xs font-normal leading-snug text-[var(--color-brand-muted)]">
                      {col.blurb}
                    </span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>

          {/* Mobile: one card per vendor, each row rendered as a labelled line.
              **Not a scroll.** A scrolled comparison on a phone hides the
              competitors, which is the one thing this page must not do. */}
          <tbody className="block md:table-row-group">
            {rows.map((row) => (
              <tr
                key={row.label}
                className="block border-t border-[var(--color-border-subtle)] first:border-t-0 md:table-row md:first:border-t"
              >
                <th
                  scope="row"
                  className="block px-4 pt-4 text-left align-top text-sm font-semibold text-neutral-950 md:table-cell md:w-[18%] md:border-t md:border-[var(--color-border-subtle)] md:p-4 md:font-medium md:text-[var(--color-brand-muted)]"
                >
                  {row.label}
                </th>
                {row.cells.map((cell, i) => {
                  const ours = columns[i]?.ours === true;
                  return (
                    <td
                      key={columns[i]?.name ?? i}
                      className={`block px-4 py-2 align-top text-sm md:table-cell md:p-4 ${
                        ours
                          ? "border-x border-[var(--color-border-subtle)] bg-[var(--color-surface-sunken)] md:border-t"
                          : "md:border-t md:border-[var(--color-border-subtle)]"
                      }`}
                    >
                      {/* **The vendor is named on every cell below 768px**, so a
                          phone reader never has to remember which card they are
                          looking at. */}
                      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-brand-muted)] md:hidden">
                        {columns[i]?.name}
                      </span>
                      <CellContent cell={cell} ours={ours} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CellContent({ cell, ours }: { cell: Cell; ours?: boolean }) {
  const tone = cell.tone ?? "neutral";
  const textClass =
    tone === "negative"
      ? "text-neutral-400"
      : ours && tone === "positive"
        ? "font-medium text-neutral-900"
        : "text-neutral-700";

  return (
    <div className="flex items-start gap-2.5">
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center ${
          tone === "negative"
            ? "text-neutral-300"
            : "text-[var(--color-brand-accent)]"
        }`}
      >
        <ToneIcon tone={tone} />
      </span>
      <span className={`leading-snug ${textClass}`}>
        {cell.code ? (
          <code className="rounded bg-[var(--color-surface-sunken)] px-1.5 py-0.5 font-mono text-[0.85em] text-neutral-800">
            {cell.text}
          </code>
        ) : (
          cell.text
        )}
      </span>
    </div>
  );
}

function ToneIcon({ tone }: { tone: Tone }) {
  if (tone === "positive") {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <path
          d="M13.5 4.5 6.5 11.5 3 8"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (tone === "negative") {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <path
          d="M4 8h8"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return null;
}
