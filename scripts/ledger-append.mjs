#!/usr/bin/env node
/**
 * Append a section to the project ledger, safely.
 *
 * ## Why this exists
 *
 * Every ledger script I wrote used `String.prototype.replace(section)` to insert a
 * section at a heading. **`replace` treats `$` specially in its replacement string** —
 * `$$` means a literal `$` — so any section documenting a template literal such as
 * `$${value}` is silently corrupted, one dollar sign per occurrence.
 *
 * It happened for real: a section about the cron review wrote `$$` four times and
 * the size guard reported a **176,000-character** discrepancy. That number is not one
 * a size check produces by accident, which is the only reason the corruption was
 * caught rather than committed.
 *
 * ## The fix
 *
 * `slice`, which has no pattern semantics. And a **byte-level guard**, so the
 * failure mode is a refusal rather than a mangled file:
 *
 * - the section must not contain a forbidden control character
 * - the file's length must grow by exactly the section's length
 * - the anchor must appear exactly once, so a second insert cannot double it
 *
 * A guard that catches its own author is worth more than one that never fires.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Characters a source or markdown file must never contain. */
const FORBIDDEN = (byte) =>
  (byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 0x7f;

/**
 * Insert `section` immediately before the line containing `anchor`.
 *
 * Returns the new file contents **without writing**, so a caller can inspect. Use
 * `appendSectionToFile` for the write.
 */
export function insertSection(source, anchor, section) {
  const first = source.indexOf(anchor);
  if (first === -1) {
    throw new Error(`anchor not found: ${anchor}`);
  }
  // Two occurrences means the insert is ambiguous — and a `replace` would have put
  // the section in both, doubling it.
  if (source.indexOf(anchor, first + anchor.length) !== -1) {
    throw new Error(`anchor appears more than once: ${anchor}`);
  }

  const next = source.slice(0, first) + section + source.slice(first);

  // The guard that caught the real corruption: `replace` silently ate dollar signs,
  // so the growth was wrong. `slice` cannot, and this makes any future regression
  // a refusal rather than a commit.
  const grew = Buffer.byteLength(next) - Buffer.byteLength(source);
  const expected = Buffer.byteLength(section);
  if (grew !== expected) {
    throw new Error(
      `section would grow the file by ${grew} bytes, expected ${expected}. Refusing to write.`,
    );
  }

  for (const byte of Buffer.from(next, "utf8")) {
    if (FORBIDDEN(byte)) {
      throw new Error("the result contains a forbidden control character");
    }
  }

  return next;
}

/** Insert a section into a ledger file, or do nothing if its marker is present. */
export function appendSectionToFile({ file, marker, anchor, section }) {
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  const source = readFileSync(file, "utf8");
  // Idempotent: a section already recorded is not recorded twice.
  if (source.includes(marker)) return false;
  writeFileSync(file, insertSection(source, anchor, section));
  return true;
}
