#!/usr/bin/env node
// Run a dev command, sending its output to the terminal *and* to a log file.
//
// ## Why this is a wrapper and not `cmd | tee`
//
// `2>&1 | tee file.log` is a shell pipeline, and it behaves differently across
// the three shells this product supports: `cmd`'s redirection into a pipe does
// not carry stderr the way `sh`'s does, and the directory the log lives in has to
// exist first — which `mkdir -p` created, and which neither BSD/macOS nor `cmd`
// has. A shell cannot express "portable" here.
//
// ## Why the first attempt was wrong in a way only a reader would catch
//
// The obvious fix is to drop the pipe and pass the tee as a second command:
// `portless run vite dev node scripts/tee-log.mjs .logs/dev.log`. That does not
// pipe anything — **the tee becomes two extra positional arguments to `vite dev`**,
// which ignores them, so nothing is ever written and the log file is created
// empty. It reads as a working pipeline and is not one.
//
// So the child is spawned here, with its two streams piped explicitly, and its
// exit code forwarded. `stdio: "inherit"` cannot be used, because the point is to
// capture the output rather than pass the terminal straight through.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [logPath, ...command] = process.argv.slice(2);
if (!logPath || command.length === 0) {
  console.error("usage: dev-with-log.mjs <log-file> <command> [args...]");
  process.exit(1);
}

const target = resolve(process.cwd(), logPath);
mkdirSync(dirname(target), { recursive: true });
const file = createWriteStream(target, { flags: "w" });

const child = spawn(command[0], command.slice(1), {
  // Inherit stdin so the dev server's interactive prompts still work, and capture
  // both output streams so they can be written to the log as well as shown.
  stdio: ["inherit", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => {
  file.write(chunk);
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  file.write(chunk);
  // **stderr goes to stderr**, which is what `2>&1` destroyed: a warning
  // interleaved into stdout reads as output, and the original script collapsed the
  // two so they could not be told apart in the log.
  process.stderr.write(chunk);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("close", (code, signal) => {
  file.end(() => {
    if (signal) process.exit(1);
    process.exit(code ?? 0);
  });
});
