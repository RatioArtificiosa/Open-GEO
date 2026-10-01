#!/usr/bin/env node
// Tee stdin to a file and to stdout, on every platform.
//
// **Why this exists rather than `2>&1 | tee`.** The pipe exists in all three
// shells, so it looks portable — and it is not. `cmd`'s redirection to a pipe
// handles some streams differently, and a path like `.logs/dev-server.log` is
// created only if the directory already exists, which `mkdir -p` was doing and
// which BSD/macOS and `cmd` do not support. So the directory is made here, and
// the tee is done here, and the script is Node, which runs everywhere the product
// does.
//
// Behaviour matches `tee`: bytes go to the file *and* to stdout, so the terminal
// still shows the dev server, and a dev server's interactive prompts keep working
// because stdin is inherited rather than consumed.
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("usage: tee-log.mjs <file>");
  process.exit(1);
}

const path = resolve(process.cwd(), target);
// `mkdirSync` recursive is the portable `mkdir -p`, and it is a no-op when the
// directory is already there.
mkdirSync(dirname(path), { recursive: true });

const file = createWriteStream(path, { flags: "w" });

process.stdin.on("error", (error) => {
  // A dev server exiting closes stdin; that is not a failure of the tee.
  if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
    console.error(`tee-log: ${error.message}`);
    process.exitCode = 1;
  }
});

process.stdin.pipe(file, { end: false });
process.stdin.pipe(process.stdout);

/**
 * Close the file when the input ends.
 *
 * `end: false` above is deliberate — a dev server holds stdin open, and closing
 * the file on the first `end` would truncate a long-running log. But that leaves
 * the case where stdin *does* end with nothing closing the file, and buffered data
 * is lost when the process exits. So the end of input ends the file, and the
 * process waits for the flush before exiting.
 *
 * The first version also had `pipeline(process.stdout, process.stdout)`, which is
 * invalid — `process.stdout` is a writable stream, not a readable source — and
 * either threw or did nothing at all. **Piping a stream into itself is the kind of
 * line that reads as plumbing and is not.**
 */
process.stdin.on("end", () => {
  file.end();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    file.end(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}
