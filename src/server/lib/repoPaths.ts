/**
 * Repository paths, in one shape, everywhere.
 *
 * ## Why this module exists
 *
 * **Three defects in this repository were the same defect.** In each case a path or an
 * identifier was compared in whatever shape the current machine produced, so the comparison
 * matched nothing:
 *
 * | where | what happened |
 * |---|---|
 * | `endpoint-path-gate` | a filter on `"src/client/"` run over `C:\…\src\client\X.tsx` — **zero files matched, and the gate reported clean** |
 * | a stale-row audit | production directory keys kept backslashes while test keys were forward-slashed, so **48 directories looked untested when 11 were** |
 * | an MCP-tool probe | `/mcp/i` matched `mcpActivation.ts` — activation, not tools — and the near-miss read as "the tools are built" |
 *
 * **The shared defect is not Windows. It is normalising once and then never again.**
 * A helper here is worth more than three comments, because the third instance cost a whole
 * mis-ranked audit and a reader would not have known the first two were the same bug.
 *
 * ## The rule
 *
 * **Normalise at the boundary, and let no caller see a separator.** Every function here takes
 * a path and returns a forward-slashed, repository-relative one, so a comparison written
 * against `"src/client/"` works on Windows, on Linux, and in CI — which is where the
 * original defects were invisible, because the machine that ran them was not the machine that
 * failed.
 */
import { relative, resolve, sep } from "node:path";

/**
 * Forward-slashed, repository-relative path.
 *
 * **`process.cwd()` as the root, so a test and the module under test agree** — a gate that
 * roots at one directory and a fixture written relative to another will compare two different
 * strings, and on the wrong machine.
 */
export function repoRelative(
  path: string,
  root: string = process.cwd(),
): string {
  return relative(root, resolve(root, path)).replaceAll("\\", "/");
}

/**
 * Whether `path` is inside `prefix`, compared on forward-slashed segments.
 *
 * **Segment-aware on purpose.** `"src/vendor"` must not match a prefix of
 * `"src/vendor-assets"`, and a plain `startsWith` would say it does — **which is how an
 * erasure sweep deletes a bucket it was never asked to delete.**
 */
export function isUnder(
  path: string,
  prefix: string,
  root: string = process.cwd(),
): boolean {
  const p = repoRelative(path, root);
  const q = repoRelative(prefix, root);
  return p === q || p.startsWith(`${q}/`);
}

/** The separator this platform produces, for the one assertion that needs to name it. */
export const PATH_SEPARATOR = sep;

/**
 * Does `name` look like a vendor image URL rather than a page?
 *
 * **A predicate rather than a regex at each call site**, because three separate regexes is three
 * chances to disagree about what "an image" means — and `/mcp/i` matching `mcpActivation.ts`
 * is exactly that failure.
 */
const IMAGE_KEY =
  /final[-_]?screenshot|screenshot[-_]?thumbnails?|image_url|imageUrl|thumbnail/i;

/** Whether `source` names a vendor host together with an image-shaped key. */
export function namesVendorImage(
  source: string,
  hosts: readonly string[],
): boolean {
  return hosts.some((host) => source.includes(host)) && IMAGE_KEY.test(source);
}
