import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const workflow = z
  .object({
    jobs: z.object({
      preview: z.object({
        steps: z.array(
          z.object({ name: z.string(), run: z.string().optional() }),
        ),
      }),
    }),
  })
  .parse(parse(readFileSync(".github/workflows/pr-preview.yml", "utf8")));
const script = workflow.jobs.preview.steps.find(
  (step) => step.name === "Verify Access protection",
)?.run;
if (!script) throw new Error("Preview Access verification step is missing");

const access = "302 https://example.cloudflareaccess.com/cdn-cgi/access/login";

/**
 * Whether this shell can run the script under test faithfully.
 *
 * The thing being verified is a **bash** step from `.github/workflows/
 * pr-preview.yml`, and that workflow pins `runs-on: ubuntu-latest`. So the script
 * has exactly one real execution environment.
 *
 * ## Why this exercises the script rather than checking the platform
 *
 * Two earlier versions failed, both for the same reason — they asked the wrong
 * question:
 *
 * 1. *"Is `bash` on PATH?"* — no. On Windows without bash the suite ran and
 *    every case died on `spawnSync bash ETIMEDOUT`. That is a statement about the
 *    host, not about the script, and eleven red tests that mean nothing is worse
 *    than an honest skip because it teaches people to ignore red.
 * 2. *"Can `bash` run a `curl` with a function override?"* — still no, and worse
 *    it *looked* fine. Git Bash is on PATH here, so the suite ran, and then
 *    failed on every case because MSYS rewrites `https://` to `https:\` in
 *    arguments. A probe that returns true on a shell that cannot run the script
 *    is worse than no probe at all.
 *
 * So the probe runs the script's **actual load-bearing construct** and requires
 * it to work: a shared file descriptor (`exec 3<`) advancing across successive
 * function calls under command substitution. That is the one thing the whole
 * fixture rests on — it is how the canned responses are handed to `curl` one at a
 * time — and it is exactly what an MSYS shell will not reproduce faithfully.
 *
 * Anything that satisfies this can run the suite, so WSL, a Linux container and CI
 * all still test it. Skipping beats deleting: this script is what stops a public
 * preview from being shared, and that guarantee should be tested everywhere it
 * *can* be tested.
 */
function shellRunsTheScriptFaithfully(): boolean {
  const probe = spawnSync(
    "bash",
    [
      "-c",
      // The same trick the fixture uses: read successive canned responses from a
      // shared descriptor, with `sleep` neutralised so the loop cannot stall.
      `exec 3< /dev/null
responses() { IFS= read -r response <&3 || response="000 "; printf '%s\\n' "$response"; }
first=$(responses)
second=$(responses)
printf '%s|%s' "$first" "$second"`,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  // Two reads from one descriptor must both yield `000 ` — proof the descriptor
  // advanced and the substitution kept its own shell state.
  return (
    probe.error === undefined &&
    probe.status === 0 &&
    probe.stdout.trim() === "000 |000"
  );
}

const shellIsUsable = shellRunsTheScriptFaithfully();

/**
 * A silent skip is a deleted test, and **in CI it is worse than that.**
 *
 * This suite is the only test of the step that keeps a *public* preview from
 * being shared with the wrong Access header. `describe.skipIf(!shellIsUsable)`
 * turns any probe failure into a green skip, and the plausible causes are all
 * environmental: a bash change on the runner image, a spawn timeout under load, a
 * changed probe string. None of them is a reason to stop testing the guard — they
 * are reasons the *probe* broke, and a green skip reports neither.
 *
 * The skip is right on a developer machine without a usable bash — that is what it
 * was written for. In CI it is a hole in the pipeline, so **the probe has to
 * pass there** and a failure is reported as a failure.
 */
if (!shellIsUsable && process.env.CI) {
  throw new Error(
    "bash cannot run the pr-preview Access script faithfully on CI, so the suite guarding " +
      "public preview access cannot be skipped silently. Fix the probe or the script; do not " +
      "remove the assertion.",
  );
}

describe.skipIf(!shellIsUsable)("preview Access verification", () => {
  it.each([
    { responses: [access], status: 0, retries: 0 },
    { responses: ["404 ", access], status: 0, retries: 1 },
    { responses: ["503 ", access], status: 0, retries: 1 },
    { responses: ["000 ", access], status: 0, retries: 1 },
    { responses: ["200 "], status: 1, retries: 0 },
    { responses: ["302 https://example.com/"], status: 1, retries: 0 },
    { responses: ["403 "], status: 1, retries: 0 },
    { responses: ["404 ", "200 "], status: 1, retries: 1 },
    { responses: Array<string>(8).fill("404 "), status: 1, retries: 8 },
    { responses: Array<string>(8).fill("503 "), status: 1, retries: 8 },
    { responses: Array<string>(8).fill("000 "), status: 1, retries: 8 },
  ])("handles $responses", ({ responses, status, retries }) => {
    const directory = mkdtempSync(join(tmpdir(), "preview-access-"));
    try {
      const responseFile = join(directory, "responses");
      writeFileSync(responseFile, responses.join("\n") + "\n");
      const result = spawnSync(
        "bash",
        [
          "-c",
          // A shared file descriptor advances even inside curl's command substitution.
          `exec 3< "$PREVIEW_RESPONSES"
curl() { local response; IFS= read -r response <&3 || response="000 "; printf '%s\\n' "$response"; }
sleep() { :; }
${script}`,
        ],
        {
          encoding: "utf8",
          timeout: 5000,
          env: {
            ...process.env,
            PREVIEW_URL: "https://preview.example.invalid",
            STAGE: "test",
            PREVIEW_RESPONSES: responseFile,
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(status);
      expect(result.stdout.match(/attempt \d:/g) ?? []).toHaveLength(retries);
      if (retries === 8) {
        expect(result.stdout).toContain("Could not verify");
        expect(result.stdout).not.toContain("preview is public");
        expect(result.stdout).not.toContain("still sits behind");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
