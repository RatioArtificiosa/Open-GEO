#!/usr/bin/env node
// Codex plugin installs copy the plugin directory and skip symlinks, so
// plugins/opengeo/skills/* must be real files, not symlinks to .agents/skills/*.
// Run this after editing any of the skills listed below. `pnpm ci:check` runs
// this and diffs the result, so a stale copy fails CI instead of shipping.
import { cpSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceDir = join(repoRoot, ".agents/skills");
const targetDir = join(repoRoot, "plugins/opengeo/skills");

/**
 * Skills that live in `.agents/skills/` and are **not** copied into the plugin.
 *
 * `setup-opengeo` is marked `metadata: internal: true` in its own front matter: it
 * walks a user through installing the plugin, which is a task a user of the plugin
 * has already completed. Shipping it would put a guide to installing the thing they
 * installed inside the thing they installed.
 *
 * Listed here rather than left to the scattered path so the next internal skill has
 * somewhere declared to go, and so `scripts/community-templates.test.ts` can check
 * the set from both directions: nothing absent from `skills` ships, and nothing on
 * disk is silently dropped.
 */
const INTERNAL_SKILLS = ["setup-opengeo"];

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
  // The issue-writing skill the README and docs/CONTRIBUTING.md both promise. It is
  // in the plugin list for the same reason the others are: Codex installs copy the
  // directory and skip symlinks, so a skill that only lives in .agents/skills/ is
  // installable from nothing.
  "simple-issue-description",
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

// **Fail rather than pass silently on an impossible combination.** A skill in
// `INTERNAL_SKILLS` that is also in `skills` would be copied into the plugin and
// contradict its own front matter — the two lists overlap exactly when somebody
// adds a skill to one and forgets the other, which is the edit this guard catches.
const overlap = skills.filter((skill) => INTERNAL_SKILLS.includes(skill));
if (overlap.length > 0) {
  console.error(
    `sync-plugin-skills: ${overlap.join(", ")} are marked internal but are in the sync list`,
  );
  process.exit(1);
}

// And the mirror: an internal skill that is missing from `INTERNAL_SKILLS` is a
// skill that silently shipped. Read from the directory, not from a second list,
// so adding a directory is the only thing required to make this notice it.
const onDisk = readdirSync(sourceDir).filter((entry) =>
  statSync(join(sourceDir, entry)).isDirectory(),
);
const undeclared = onDisk.filter(
  (skill) => !skills.includes(skill) && !INTERNAL_SKILLS.includes(skill),
);
if (undeclared.length > 0) {
  console.error(
    `sync-plugin-skills: ${undeclared.join(", ")} exist in .agents/skills but are in ` +
      "neither the sync list nor INTERNAL_SKILLS. Declare them: a skill with no " +
      "declaration is a skill that either ships by accident or disappears by accident.",
  );
  process.exit(1);
}

console.log(
  `Synced ${skills.length} skills into plugins/opengeo/skills/ ` +
    `(${INTERNAL_SKILLS.length} internal, not shipped)`,
);

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
