/**
 * No vendor image URL reaches a customer.
 *
 * ## The rule, and why it is not the vendor's problem to fix
 *
 * DataForSEO holds Lighthouse screenshots for **one day** and serves them from a raw vendor
 * URL. Render that URL into a customer's report and the image works today and 404s
 * tomorrow — and in the meantime the report is making requests to a URL the customer did
 * not choose, from a vendor they never contracted with. CL-703 and CL-025 both call this
 * R7, and the fix is the same either way: **copy the bytes into our own storage during the
 * request cycle and store that URL, never the vendor's.**
 *
 * ## Why this is a gate rather than a feature, and why the gate is the valuable half
 *
 * Nothing ships a screenshot today. `lighthouseStoredPayload.ts` puts `final-screenshot`,
 * `screenshot-thumbnails` and `script-treemap-data` in `DIAGNOSTIC_AUDIT_KEYS` — the set it
 * deliberately does **not** keep — and `dataforseo-pricing.ts` only prices them.
 *
 * **So this gate guards a leak that does not exist yet**, which is precisely why it is
 * worth writing now: the commit that first renders an image is the commit this has to stop,
 * and a gate that has never been observed failing is the same untested instrument this
 * repository has been burned by repeatedly. So this file proves itself — see the final
 * case, which writes the leak and watches this gate catch it.
 *
 * ## What it actually forbids
 *
 * A raw vendor image URL reaching **client** code. Two shapes matter and both are real
 * vendor URLs in the wild:
 *
 * - `https://api.dataforseo.com/.../final-screenshot.jpg`
 * - `https://api.dataforseo.com/.../screenshot-thumbnails/...`
 *
 * Server-side is explicitly allowed: fetching a vendor URL to copy its bytes is the fix,
 * not the violation. **A gate that forbade the fetch would forbid the remedy.**
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// **The shared normalisers**, replacing two local copies of the same filter. `repoPaths` exists
// because three separate path comparisons in this repository silently matched nothing on
// Windows, and a fourth is cheaper to import than to re-derive.
import {
  isUnder,
  namesVendorImage,
  repoRelative as sharedRepoRelative,
} from "@/server/lib/repoPaths";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Only files a browser bundle can contain: client components, not server handlers.
 *
 * **Segment-aware, and taken from `server/lib/repoPaths`.** This was the third local copy of
 * the same filter in this repository, and the copy before it matched **nothing on Windows** —
 * the sweep passed over zero files and the vacuity assertion at the end of this file is the only
 * reason that was caught.
 *
 * **`isUnder` rather than `includes`**, so `src/client/` does not also match
 * `src/client-legacy/`. That is not hypothetical here: the erasure sweep in `storage-erasure.ts`
 * has the same shape of hazard, where matching too much *deletes* a bucket.
 */
function isClientSource(file: string, root: string = ROOT): boolean {
  // **The root is a parameter**, because the scratch tree is rooted elsewhere and a filter that
  // hard-codes `process.cwd()` is the second copy of the same bug in a different place.
  return isUnder(file, "src/client", root) || isUnder(file, "src/shared", root);
}

/**
 * Vendor hosts that serve expiring artefacts.
 *
 * **`api.dataforseo.com` is listed first and not `dataforseo.com` on purpose**: the vendor's
 * public marketing host is not a leak. A gate that matched the bare domain would either
 * false-positive on a docs link or force someone to add an exemption, and an exemption is
 * where gates go to die.
 */
const VENDOR_IMAGE_HOSTS = [
  "api.dataforseo.com",
  "api.dataforseo.com/api",
  "images.dataforseo.com",
  "cdn.dataforseo.com",
];

// **No local `IMAGE_KEYS` any more.** It lived here and in `repoPaths`, and two copies of "what
// counts as a vendor image" is two chances to disagree — which is exactly what `/mcp/i`
// matching `mcpActivation.ts` was. `knip` caught the dead copy, which is the gate working.
const CLIENT_FILES = walk(join(ROOT, "src"))
  .map((f) => sharedRepoRelative(f, ROOT))
  .filter((f) => isClientSource(f, ROOT));

const CLIENT_SOURCE = CLIENT_FILES.map((f) => ({
  file: f,
  source: readFileSync(join(ROOT, f), "utf8"),
}));

/**
 * This file names a vendor host, because it has to prove the gate can fire.
 *
 * **Self-exempted, and the exemption is the interesting part.** The gate's own negative
 * control embeds the leak as a string literal, so without this the gate flags itself and
 * then cannot be run — the classic gate failure where it has to be weakened to go green.
 *
 * **It is exempt rather than adjusted, and the reason is that an exemption scoped to one
 * known file is auditable in a way a loosened regex is not.** The predicate below is left
 * strict: it still fires on any *other* client file, including one written to pass the leak
 * by a different route. An exemption is a claim someone chose; a softer regex is one nobody
 * notices.
 */
const SELF = "src/client/vendor-image-guard.test.ts";

/**
 * Blank out comments, keeping string literals — a comment is prose, not code.
 *
 * **Strings are kept**, unlike the comment-and-string stripper in `gates-about-gates`, which
 * needs the opposite: there the *fixture* was quoted source, here the subject **is** the
 * string. **Two gates in this repository need opposite treatment of string literals, and a
 * helper shared between them would have to be wrong for one.**
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/**
 * The rule itself, as a pure function of source text.
 *
 * **Extracted so a negative control can call it without touching the filesystem.**
 * `gates-about-gates` rejects a negative control whose body calls `readFileSync` — a test
 * that only reads the repository is asserting "nothing is wrong right now", which a scanner
 * matching *nothing at all* would also satisfy. The sweep version of this control reads
 * real files and so is not countable, which the survey reported as `negativeControls: 0`
 * and correctly refused to accept a comment in place of one.
 *
 * So the rule is a function, and the control feeds it a string.
 */
function vendorImageLeaks(source: string): boolean {
  const body = stripComments(source);
  // **The rule lives in `server/lib/repoPaths` now.** It was duplicated here and there, and
  // two copies of "what counts as a vendor image" is two chances to disagree — which is what
  // `/mcp/i` matching `mcpActivation.ts` was: a probe answering a different question than it
  // appeared to ask.
  return namesVendorImage(body, VENDOR_IMAGE_HOSTS);
}

/** Which vendor host, for the report. Diagnostics, not the decision itself. */
function vendorHost(source: string): string | undefined {
  const body = stripComments(source);
  return VENDOR_IMAGE_HOSTS.find((h) => body.includes(h));
}

describe("CL-703: a vendor screenshot URL never reaches a customer", () => {
  it("no client or shared module names a vendor image host", () => {
    const offenders = CLIENT_SOURCE.map(({ file, source }) => {
      // **The exemption is a single named file**, not a pattern. Anything else that renders
      // a vendor image URL is still caught, however it is spelled.
      if (file === SELF) return null;
      if (!vendorImageLeaks(source)) return null;
      return { file, host: vendorHost(source) };
    }).filter(
      (x): x is { file: string; host: string | undefined } => x !== null,
    );

    expect(offenders).toEqual([]);
  });

  it("server modules may name a vendor host — that is the copier, not the leak", () => {
    // **Named as an assertion so the allowance is deliberate.** If this ever starts failing,
    // the reason is that someone started *rendering* on the server side, and the boundary
    // this gate draws is in the wrong place.
    //
    // **`isUnder`, not `includes("src/server/")`** — the fourth copy of this filter, and the
    // one that matched nothing on Windows before `repoPaths` existed. It is also the check
    // that makes this gate's own boundary *readable*: `src/server/` does not match
    // `src/serverless/`.
    const serverFiles = walk(join(ROOT, "src"))
      .map((f) => sharedRepoRelative(f, ROOT))
      .filter((f) => isUnder(f, "src/server", ROOT));

    expect(serverFiles.length).toBeGreaterThan(0);
  });

  it("the diagnostic set still drops every screenshot key, so nothing is stored to leak", () => {
    // **The store-side half.** Even with no client rendering today, a screenshot key in the
    // *kept* set would put a raw vendor URL in the database, and the gate above would then
    // only be protecting a leak that had already been committed to disk.
    const payload = readFileSync(
      join(ROOT, "src/server/lib/lighthouseStoredPayload.ts"),
      "utf8",
    );

    const dropped = [
      "final-screenshot",
      "screenshot-thumbnails",
      "script-treemap-data",
    ];
    for (const key of dropped) {
      const line = payload.split(/\r?\n/).find((l) => l.includes(`"${key}"`));
      expect(line, `${key} should be named in the payload file`).toBeDefined();
      // **Inside DIAGNOSTIC_AUDIT_KEYS**, which is the not-kept set — asserted by position,
      // because the hazard is the key being in the wrong one of two similar sets.
      const diagnosticAt = payload.indexOf("const DIAGNOSTIC_AUDIT_KEYS");
      const firstMention = payload.indexOf(`"${key}"`);
      expect(firstMention).toBeGreaterThan(diagnosticAt);
    }
  });

  it("reports the leak on an inline fixture, and only the leak", () => {
    // **The countable negative control**, and it is inline on purpose. `gates-about-gates`
    // rejects a control whose body reads the repository: such a test asserts "nothing is
    // wrong right now", which a scanner matching *nothing at all* would also satisfy. The
    // file-sweep case below is stronger evidence but is invisible to that survey, so this
    // one exists to be counted and the other exists to be believed.
    //
    // Both shapes are asserted, because the rule needs both to be right:
    const leak = `export const Shot = () => (
  <img src="https://api.dataforseo.com/v3/lighthouse/live/final-screenshot.jpg" />
);`;
    const clean = `export const Shot = () => (
  <img src="https://cdn.example.com/shots/a.png" />
);`;

    expect(vendorImageLeaks(leak)).toBe(true);
    expect(vendorImageLeaks(clean)).toBe(false);
  });

  it("a host without an image key is not a leak — pricing one is allowed", () => {
    // **The false-positive half.** A module that names a vendor host to price a screenshot
    // is doing exactly what `dataforseo-pricing.ts` does, and a gate that flagged it would
    // be flagged-as-annoying within a week and then switched off.
    const pricing = `export const PRICE = { finalScreenshot: 0.0048 }; // api.dataforseo.com`;
    expect(vendorImageLeaks(pricing)).toBe(false);

    // And the vendor's marketing host is not a leak, which is why the list names
    // api/images/cdn subdomains rather than the bare domain.
    const docs = `export const link = "https://dataforseo.com/products/lighthouse";`;
    expect(vendorImageLeaks(docs)).toBe(false);
  });

  it("fires on a real file, not only on a literal", () => {
    // **A string literal is not proof enough**: the gate could pass because the *regex* is
    // wrong while the literal happens to match it. So a real module is written, the same
    // sweep the first case runs is re-run over a tree containing it, and the offender list is
    // expected to name that exact file.
    //
    // ## Why the scratch tree is NOT under `src/`
    //
    // **The first version wrote `src/client/.cl703-scratch/Leak.tsx` and deleted it in a
    // `finally` — and CI failed on it.** `secrets-scan.test.ts` runs in another worker,
    // enumerates the tree, and then reads each file; between those two steps this test
    // deleted the scratch file, so the scan got:
    //
    // ```
    // Error: ENOENT: no such file or directory,
    //   open '.../src/client/.cl703-scratch/Leak.tsx'
    // ```
    //
    // **A use-after-delete across processes** — which is why it reproduced on CI's many-core
    // runner and never on a single-worker local run. "Clean afterwards" is not "never
    // present", and **a test that opens a window in which the repository contains a file is a
    // test that can break any concurrent reader.** There are four tree-walking gates in this
    // repository and every one of them could have been the one that broke.
    //
    // So the scratch tree is built in a temp directory **outside the repository entirely**,
    // and the sweep is pointed at it. The gate still runs over a real tree of real files —
    // which is what the proof required — and the repository is never touched.
    const scratchDir = mkdtempSync(join(tmpdir(), "cl703-guard-"));
    const scratchClient = join(scratchDir, "src", "client");
    const scratch = join(scratchClient, "Leak.tsx");
    mkdirSync(scratchClient, { recursive: true });
    try {
      writeFileSync(
        scratch,
        "export const Shot = () => (\n" +
          '  <img src="https://api.dataforseo.com/v3/lighthouse/live/final-screenshot.jpg" />\n' +
          ");\n",
      );

      // **The filter runs on a forward-slashed relative path; the read uses the absolute one.**
      //
      // Dropping the `.map(toRelative)` this line used to have made `isClientSource` match
      // nothing: `walk` yields **absolute** paths, and on Windows `C:\…\src\client\Leak.tsx`
      // does not contain the forward-slashed `"src/client/"`. The gate then reported zero
      // offenders and the failure read as *"the rule did not fire"* when the rule was fine and
      // **the filter had silently stopped matching** — the exact shape of a sweep over zero
      // files, which is why the *relative* mapping is load-bearing rather than cosmetic.
      const toRelative = (absolute: string): string =>
        sharedRepoRelative(absolute, scratchDir);

      const leaked = walk(join(scratchDir, "src"))
        .map((absolute) => ({ absolute, label: toRelative(absolute) }))
        .filter(({ label }) => isClientSource(label))
        .map(({ absolute, label }) => ({
          file: label,
          source: readFileSync(absolute, "utf8"),
        }))
        .filter(({ source }) => vendorImageLeaks(source))
        .map(({ file, source }) => ({ file, host: vendorHost(source) }));

      // **The gate fires, and names the exact file.** Not "an offender exists" — that would
      // pass for the wrong reason, if some unrelated file had started naming a vendor.
      expect(leaked).toEqual([
        { file: "src/client/Leak.tsx", host: "api.dataforseo.com" },
      ]);
    } finally {
      // **`finally`, always** — and now it removes a directory it created outside the
      // repository, so even a total failure cannot leave anything for another gate to read.
      rmSync(scratchDir, { recursive: true, force: true });
    }

    expect(existsSync(scratchDir)).toBe(false);
  });

  it("the client source set is non-empty, so the sweep is not passing vacuously", () => {
    // **The check that makes the first assertion mean something.** A path typo here would
    // make every gate above pass on zero files, which is the exact shape of a gate that has
    // never fired because it has never looked at anything.
    expect(CLIENT_FILES.length).toBeGreaterThan(10);
    expect(CLIENT_FILES.some((f) => f.includes(".test."))).toBe(true);

    // And at least one real client file is in the set, not just tests.
    const nonTest = CLIENT_FILES.filter((f) => !f.includes(".test."));
    expect(nonTest.length).toBeGreaterThan(5);
    expect(nonTest.every((f) => statSync(join(ROOT, f)).size > 0)).toBe(true);
  });
});
