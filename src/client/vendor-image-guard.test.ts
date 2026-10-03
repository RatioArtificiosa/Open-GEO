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
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
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
 * Repository-relative, forward-slashed path.
 *
 * **`relative()` rather than a string replace, and this is the third bug in this one file
 * from one cause.** `join()` emits `\` on Windows, so `path.replace(`${ROOT}/`, "")` never
 * matched — the sweep tried to open
 * `G:\opengeo\Open-GEO\G:\opengeo\Open-GEO\src\...`, two absolute roots in one path. Three
 * symptoms, one mistake: **a path filter written for POSIX and run on Windows.** Normalise
 * at this boundary, once, and never touch separators again.
 */
function repoRelative(full: string): string {
  return relative(ROOT, full).replace(/\\/g, "/");
}

/**
 * Only files a browser bundle can contain: client components, not server handlers.
 *
 * **Matched on forward slashes, always.** A filter built from `join` silently matches
 * nothing on Windows — which is exactly what happened: the sweep passed over zero files, and
 * the vacuity check at the end of this file is what caught it. No path filter here may be
 * built from `join`.
 */
function isClientSource(file: string): boolean {
  return file.includes("src/client/") || file.includes("src/shared/");
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

const IMAGE_KEYS =
  /final[-_]?screenshot|screenshot[-_]?thumbnails?|image_url|imageUrl|thumbnail/i;

const CLIENT_FILES = walk(join(ROOT, "src"))
  .map(repoRelative)
  .filter(isClientSource);

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

/** Strip comments so a URL in a doc block is not reported as code that can render. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("CL-703: a vendor screenshot URL never reaches a customer", () => {
  it("no client or shared module names a vendor image host", () => {
    const offenders = CLIENT_SOURCE.map(({ file, source }) => {
      // **The exemption is a single named file**, not a pattern. Anything else that renders
      // a vendor image URL is still caught, however it is spelled.
      if (file === SELF) return null;
      const body = codeOnly(source);
      const host = VENDOR_IMAGE_HOSTS.find((h) => body.includes(h));
      // **A host alone is not a leak** — the module may be pricing one, or a doc link.
      // The gate fires only where an *image-shaped* reference and the host co-occur.
      if (host === undefined || !IMAGE_KEYS.test(body)) return null;
      return { file, host };
    }).filter((x): x is { file: string; host: string } => x !== null);

    expect(offenders).toEqual([]);
  });

  it("server modules may name a vendor host — that is the copier, not the leak", () => {
    // **Named as an assertion so the allowance is deliberate.** If this ever starts failing,
    // the reason is that someone started *rendering* on the server side, and the boundary
    // this gate draws is in the wrong place.
    const serverFiles = walk(join(ROOT, "src"))
      .map(repoRelative)
      .filter((f) => f.includes("src/server/"));

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

  it("the gate catches the leak it exists for — proved on a real file, not a fixture", () => {
    // **A prospective guard that has never been observed failing is an untested
    // instrument**, and this repository has been burned by enough of those. A string literal
    // is not proof enough either: the gate could pass because the *regex* is wrong while the
    // literal happens to match it. So a real module is written to a scratch path inside
    // `src/client`, the real sweep runs over it, and the offender list is expected to name
    // it.
    const scratchDir = join(ROOT, "src", "client", ".cl703-scratch");
    const scratch = join(scratchDir, "Leak.tsx");
    mkdirSync(scratchDir, { recursive: true });
    try {
      writeFileSync(
        scratch,
        "export const Shot = () => (\n" +
          '  <img src="https://api.dataforseo.com/v3/lighthouse/live/final-screenshot.jpg" />\n' +
          ");\n",
      );

      const leaked = walk(join(ROOT, "src"))
        .map(repoRelative)
        .filter(isClientSource)
        .filter((f) => f !== SELF)
        .map((f) => ({ file: f, source: readFileSync(join(ROOT, f), "utf8") }))
        .map(({ file, source }) => {
          const body = codeOnly(source);
          const host = VENDOR_IMAGE_HOSTS.find((h) => body.includes(h));
          if (host === undefined || !IMAGE_KEYS.test(body)) return null;
          return { file, host };
        })
        .filter((x): x is { file: string; host: string } => x !== null);

      // **The gate fires, and names the exact file.** Not "an offender exists" — that would
      // pass for the wrong reason, e.g. if some unrelated file had started naming a vendor.
      expect(leaked).toEqual([
        {
          file: "src/client/.cl703-scratch/Leak.tsx",
          host: "api.dataforseo.com",
        },
      ]);
    } finally {
      // **`finally`, always.** A test that writes a file into `src/` and can leave it behind
      // is a test that poisons the tree on failure, and the next run's gate sweep would
      // read the leak as a real offender — a failure that manufactures its own next failure.
      rmSync(scratchDir, { recursive: true, force: true });
    }

    expect(existsSync(scratchDir)).toBe(false);
  });

  it("a legitimate report image on our own CDN is not flagged", () => {
    // **The other half, and the half that decides whether the gate survives a week.** A
    // gate that fires on our own assets gets switched off, and a switched-off gate is worse
    // than none because it still reads as covered.
    const own =
      'export const Shot = () => <img src="https://cdn.example.com/shots/a.png" />;';
    expect(VENDOR_IMAGE_HOSTS.some((h) => codeOnly(own).includes(h))).toBe(
      false,
    );

    // And the vendor's *marketing* host is not a leak either, which is why the list names
    // api/images/cdn subdomains rather than the bare domain.
    const docs =
      'export const link = "https://dataforseo.com/products/lighthouse";';
    expect(VENDOR_IMAGE_HOSTS.some((h) => docs.includes(h))).toBe(false);
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
