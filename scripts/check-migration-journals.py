#!/usr/bin/env python3
"""
Migration journal integrity, in a language nothing else here uses.

## Why Python at all

The repository is TypeScript, and every invariant about the drizzle journals is
already covered by `scripts/migration-coverage.test.ts`. So this is **not** a
second copy of an existing test — it checks two things that suite does not:

1. **The journals are strictly ordered**, on *both* dialects, with no duplicate
   `idx` and no duplicate `when`. The TS suite asks "does this harness name a
   migration newer than the ones it applies?"; nothing asks whether the journal
   itself is a sequence, and a journal that goes backwards applies migrations in
   the wrong order on a fresh database.
2. **Every migration a journal names exists on disk, and every file on disk is
   named by its journal.** An orphaned `.sql` is a migration that will never be
   applied, and a journal entry pointing at a missing file fails at deploy time
   rather than at review time.

The languages are different on purpose. A second suite in the language the code is
written in tends to be skipped when the language's toolchain is slow, and this one
runs on a stock `python3` with no install — so it can be wired into a pre-commit
hook or a developer's first command on any of the three platforms the product
supports.

Exit code 0 means every invariant held. Anything else prints what failed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# (journal path, directory the tags name)
DIALECTS = [
    (Path("drizzle/meta/_journal.json"), Path("drizzle")),
    (Path("drizzle-pg/meta/_journal.json"), Path("drizzle-pg")),
]


def load(path: Path) -> list[dict]:
    """The journal's entry list, or a hard failure if the shape is wrong."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    entries = raw.get("entries")
    if not isinstance(entries, list):
        raise SystemExit(f"{path}: no 'entries' list")
    return entries


def check_ordered(name: str, entries: list[dict]) -> list[str]:
    """idx ascending, when ascending, no duplicates, and every tag numbered."""
    problems: list[str] = []

    idxs = [e.get("idx") for e in entries]
    whens = [e.get("when") for e in entries]

    for label, values in (("idx", idxs), ("when", whens)):
        if any(v is None for v in values):
            problems.append(f"{name}: an entry has no {label}")
            continue
        if len(set(values)) != len(values):
            dupes = sorted({v for v in values if values.count(v) > 1})
            problems.append(f"{name}: duplicate {label} values {dupes}")
        if values != sorted(values):
            # Report the first inversion, which is the one a deploy would trip on.
            for i in range(1, len(values)):
                if values[i] < values[i - 1]:
                    problems.append(
                        f"{name}: {label} goes backwards at position {i} "
                        f"({values[i - 1]} -> {values[i]})"
                    )
                    break

    for i, entry in enumerate(entries):
        if entry.get("idx") != i:
            problems.append(
                f"{name}: entry {i} declares idx {entry.get('idx')!r}; "
                "the list must be densely numbered so a missing entry is visible"
            )
        tag = entry.get("tag", "")
        if not tag.startswith(f"{entry.get('idx', -1):04d}_"):
            problems.append(
                f"{name}: tag {tag!r} does not begin with its own index"
            )
    return problems


def check_files_match(name: str, entries: list[dict], directory: Path) -> list[str]:
    """Every journal tag names a file, and every file is named by the journal."""
    problems: list[str] = []

    named = {str(e.get("tag")) for e in entries}
    on_disk = {p.stem for p in directory.glob("*.sql")}

    for missing in sorted(named - on_disk):
        problems.append(f"{name}: journal names {missing}.sql, which does not exist")
    for orphan in sorted(on_disk - named):
        problems.append(
            f"{name}: {orphan}.sql exists but no journal entry applies it, so a "
            "fresh database will never receive it"
        )
    return problems


def main() -> int:
    all_problems: list[str] = []

    for journal, directory in DIALECTS:
        path = ROOT / journal
        if not path.exists():
            all_problems.append(f"{journal}: missing")
            continue
        entries = load(path)
        name = str(journal)
        all_problems += check_ordered(name, entries)
        all_problems += check_files_match(name, entries, ROOT / directory)
        print(
            f"{journal}: {len(entries)} entries, "
            f"{len(list((ROOT / directory).glob('*.sql')))} files"
        )

    if all_problems:
        print("", file=sys.stderr)
        print("migration journal problems:", file=sys.stderr)
        for p in all_problems:
            print(f"  {p}", file=sys.stderr)
        return 1

    print("journals ordered and consistent on both dialects")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())