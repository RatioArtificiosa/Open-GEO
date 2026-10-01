#!/usr/bin/env node
// Codex plugin installs copy the plugin directory and skip symlinks, so
// plugins/opengeo/skills/* must be real files, not symlinks to .agents/skills/*.
// Run this after editing any of the skills listed below. `pnpm ci:check` runs
// this and diffs the result, so a stale copy fails CI instead of shipping.
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceDir = join(repoRoot, ".agents/skills");
const targetDir = join(repoRoot, "plugins/opengeo/skills");

const skills = [
  // GEO — the differentiators. Keep first; they are the reason to install this.
  "opengeo",
  "geo-audit",
  "what-to-build",
  // Classic SEO parity with upstream OpenSEO.
  "competitive-landscape",
  "competitor-analysis",
  "keyword-clustering",
  "keyword-research",
  "link-prospecting",
  "local-seo",
  "seo-audit",
  "seo-coach",
  "seo-project-setup",
  "seo-report",
];

// Wipe and rebuild so a skill removed from the list above doesn't leave a
// stale copy behind.
rmSync(targetDir, { recursive: true, force: true });
for (const skill of skills) {
  cpSync(join(sourceDir, skill), join(targetDir, skill), {
    recursive: true,
    dereference: true,
  });
}

console.log(`Synced ${skills.length} skills into plugins/opengeo/skills/`);

/**
 * Fail if the sync left the tree dirty.
 *
 * **This check used to live in `package.json` as**
 * `test -z "$(git status --porcelain -- plugins/opengeo/skills)"`, which is POSIX
 * only: `cmd` has no `test` builtin and no command substitution, so `pnpm ci:check`
 * — the command every developer runs before pushing — **could not complete on a
 * Windows machine.** Verified by running both spellings through `cmd`, which
 * failed the POSIX one and succeeded on the directory listing.
 *
 * Here instead, because this file is Node and Node runs on all three platforms the
 * product supports. The check is the same one: a skill edited without a re-sync
 * fails CI rather than shipping a stale copy.
 */
if (process.env.CI) {
  const { execFileSync } = await import("node:child_process");
  // `--porcelain` is machine-readable and does not page, so its empty output is
  // the test. Read through `execFileSync` rather than a shell so no quoting
  // question arises on either platform.
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--", "plugins/opengeo/skills"],
    {
      encoding: "utf8",
    },
  ).trim();
  if (dirty !== "") {
    console.error(
      "The plugin skills are out of date with .agents/skills. Run `pnpm sync-plugin-skills` and commit the result.",
    );
    for (const line of dirty.split("\n")) console.error("  " + line);
    process.exitCode = 1;
  }
}
