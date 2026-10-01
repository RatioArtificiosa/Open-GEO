// Points `check:journals` at whichever Python this platform has.
//
// `python3` does not exist on Windows and `python` is not on every Linux; the
// *first version of this script used `python3` in package.json*, which is the same
// class of bug the cross-platform gate was just written to catch — a script that
// cannot run on one of the three platforms the product supports.
//
// So the launcher is a tiny Node script that probes both names. Node is already
// required by every other script here, so this adds no dependency.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "check-migration-journals.py");

if (!existsSync(script)) {
  console.error(`check-migration-journals: ${script} does not exist`);
  process.exit(1);
}

// `python3` first, then `py -3`, then `python` — the order that works on Linux,
// then on a Windows launcher, then on a plain Windows install.
const CANDIDATES = [
  { cmd: "python3", args: [] },
  { cmd: "py", args: ["-3"] },
  { cmd: "python", args: [] },
];

const tried = [];
for (const { cmd, args } of CANDIDATES) {
  const probe = spawnSync(cmd, [...args, "--version"], { encoding: "utf8" });
  if (probe.error) {
    tried.push(`${cmd} (${probe.error.code ?? "not found"})`);
    continue;
  }
  // **A version probe is not enough on Windows.** With no Python installed, `cmd`
  // finds the Microsoft Store alias and prints a message *on stdout* with exit
  // code 0 — so a `status === 0` test accepts a stub that is not an interpreter,
  // and the real run then fails with a wall of text about the Store. The check is
  // that the output *looks like a version*, which is the only signal that survives
  // both platforms.
  const version = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
  if (!/^Python\s+\d+\./i.test(version)) {
    tried.push(
      `${cmd} (not a Python ${version ? `— said "${version.split("\n")[0]}"` : "interpreter"})`,
    );
    continue;
  }
  const run = spawnSync(cmd, [...args, script], { stdio: "inherit" });
  process.exit(run.status ?? 1);
}

// Nothing ran, so the check is skipped rather than silently passed — a gate that
// reports success because it could not start is the failure mode this repository
// has now hit several times.
tried.push("(none responded)");
console.error(
  "No Python interpreter found for the migration-journal check. Tried: " +
    tried.join(", "),
);
console.error(
  "Install Python 3, or run `python scripts/check-migration-journals.py` yourself.",
);
process.exit(1);
