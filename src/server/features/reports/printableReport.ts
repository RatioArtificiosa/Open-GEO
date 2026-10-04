/**
 * The printable document a report is downloaded as.
 *
 * ## Why this is a pure string builder and not a PDF writer
 *
 * `specs/0012-dynamic-reports.md:49` lists server-side PDF under *Not in scope*,
 * and line 44 gives the reason: *"the report is a real document with its own print
 * CSS, so the browser prints it."* Checked against what the report actually uses,
 * the reasoning holds — see `docs/cl-303-export-decision.md`:
 *
 * - `@page` margin boxes with `counter(page) " of " counter(pages)`
 * - `break-inside:avoid` on tables, figures, rows and cells
 * - `orphans:3; widows:3`
 * - `print-color-adjust:exact`, without which charts print blank
 *
 * **Every one is a browser print-engine feature.** A hand-rolled writer would have
 * to embed and subset fonts, kern, and paginate model-authored HTML while
 * honouring break rules — on a Worker whose P90 heap already sits near its limit.
 * The result would look worse than what prints today, which is the opposite of what
 * a deliverable an agency sends to a client is for.
 *
 * So the artefact is a document the browser saves as PDF, and **the work is
 * making it a download and carrying the white-label identity through it.**
 *
 * ## What "white-label" means here, since there is no column for it
 *
 * There is no logo, client name or accent column anywhere in the schema. The only
 * white-labelling in the system is *inside the document*: the `--accent` custom
 * property, which the seo-report skill calls *"the one token a report template may
 * change"*, and the `.byline`. **So the branding is read out of the stored HTML**,
 * because that is where it lives and no other place knows about it.
 */
import { PRINT_SCRIPT, reportCsp } from "@/shared/report-sandbox";

/**
 * Matches an `--accent` declaration whose value is a hex colour **and nothing
 * else**.
 *
 * **Bounded by a lookahead, and only against letters.** It stops `#1C4ED8x` — a
 * longer token than a hex colour — from matching, and the
 * `/^#[0-9a-f]{3,8}$/` on the captured value is what refuses
 * `#1C4ED8;}</style>`, because the capture is the token and not a prefix.
 *
 * **An earlier version put `;` and `}` in that class as well, and those are the
 * *ordinary* delimiters of a CSS declaration.** So `--accent:#1C4ED8}` — the
 * shape every real report emits — stopped matching, and a valid brand colour
 * read as no brand colour at all. **A guard that rejects valid input costs
 * more than the attack it prevents.**
 */
const ACCENT_DECLARATION = /--accent\s*:\s*(#[0-9a-f]{3,8})(?![0-9a-z])/i;

/**
 * The byline is the document's own "Prepared for …" line, and the only
 * white-label element the export can read out of the stored HTML.
 */
const BYLINE_CLASS = "byline";

/**
 * The accent colour a document declares, or `null` when it uses the default.
 *
 * **The default is a variable reference, not a colour** — `--accent:var(--fg)`, so
 * a report with no template resolves it to the text colour. Reporting that as an
 * accent would be claiming a brand colour the document does not have, so
 * `var(...)` is reported as **no accent**, which is what it is.
 */
export function extractAccent(html: string): string | null {
  // **The pattern is the whole validation.** It requires a literal `#` and a hex
  // body, so a keyword, a `var()` reference, an over-long token and a bare
  // `1C4ED8` cannot match at all — which is why there is no second guard here. A
  // hex-colour check after it was dead code: **no input could reach it**, which is
  // exactly why mutating it to a no-op changed nothing.
  return ACCENT_DECLARATION.exec(html)?.[1]?.trim() ?? null;
}

/**
 * The byline text, or `null` when the document has none.
 *
 * **Stripped of markup and collapsed**, because a byline is a sentence on a page
 * and a filename is one line of it. HTML entities are decoded for the common named
 * cases rather than pulled in wholesale: this runs on a filename, and a full entity
 * decoder is a dependency for three substitutions.
 */
export function extractByline(html: string): string | null {
  // **Built from the constant, not a duplicated literal.** Two copies of a class
  // name would drift the moment the skill renamed the element, and one of them
  // would keep matching a byline that no longer exists.
  //
  // **The tag name comes back as group 1, so `</\1>` closes *this* element.**
  // `([\s\S]*?)</` alone closes on the first tag, which truncates a byline at any
  // nested markup — "Prepared for <strong>Northwind</strong>" read as just
  // "Prepared for", dropping the client's name, which is the one thing a
  // white-labelled byline exists to carry.
  const element = new RegExp(
    String.raw`<(\w+)[^>]*\sclass="[^"]*\b${BYLINE_CLASS}(?![\w-])[^"]*"[^>]*>` +
      String.raw`([\s\S]*?)<\/\1>`,
    "i",
  ).exec(html);
  if (element === null) return null;

  const text = (element[2] ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? null : text;
}

/**
 * The white-label identity a document carries, or `null` when it has none.
 *
 * ## Why this exists rather than letting callers use `extractAccent` directly
 *
 * The accent guard — "is this actually a hex colour, or is it a `var()` reference,
 * a keyword, or an over-long token?" — had **no seam outside `extractAccent`**: a
 * mutation that made that guard a no-op left every test green, because the only
 * assertions were on the private return value. **A rule with nowhere to be observed
 * is the most expensive kind of missing test**, and the fix is a shape a caller can
 * consume, not another assertion on a private function.
 *
 * `null` means **untemplated**, and that is a real answer rather than an absence:
 * a report with no template must export as OpenGEO's own document, not as a
 * document claiming an accent it does not have.
 *
 * **The shape is declared inline rather than as a named export**, because nothing
 * names it — knip flags an exported type nothing references, and a second place to
 * change is a second place to forget.
 */
export function whiteLabelFor(html: string): {
  accent: string;
  byline: string | null;
} | null {
  const accent = extractAccent(html);
  if (accent === null) return null;
  return { accent, byline: extractByline(html) };
}

/**
 * A filename for the download.
 *
 * **Built from the title, not the id**, because a file a client receives should
 * say what it is. Falls back to the id when the title is unusable, since a
 * download with no name is worse than one with an ugly name.
 *
 * The character set is deliberately narrow: a title is model-authored and a
 * filename crosses three systems (Windows, macOS, and a \`Content-Disposition\`
 * header that is not UTF-8-safe), so anything outside word characters, spaces and a
 * few punctuation marks becomes a hyphen.
 */
export function printableFilename(title: string, id: string): string {
  const safe = title
    .normalize("NFKD")
    // Drop combining marks so "Rapport d'audit" does not become "Rapport daudit".
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{Letter}\p{Number} &._-]+/gu, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80)
    .trim();
  // **The extension is on both branches.** A fallback named `report-r1` is a file
  // with no type, and a client cannot open that.
  return safe === "" ? `report-${id}.html` : `${safe}.html`;
}

/**
 * The document served as a download.
 *
 * **The stored HTML is served unchanged.** It is what the report is, it is already
 * a full document with its own print CSS, and re-serialising it would be the one
 * change that could make the download differ from what prints. The one thing added
 * is the print script, because a download needs the dialog to open itself — the
 * same one `?print=1` injects, from the same constant, so the two cannot diverge.
 *
 * ## Why `attachment`, and why the sandbox is widened
 *
 * `attachment` is what makes it a file rather than a navigation. The CSP is the
 * print policy for the same reason `?print=1` uses it: the script needs
 * `allow-scripts` and `allow-modals`, and the `script-src` hash is what keeps the
 * report's *own* scripts blocked. **A download that ran the report's scripts would
 * be the sandbox bypass this system exists to prevent.**
 */
export function printableDocument(
  html: string,
  title: string,
  id: string,
): Response {
  return new Response(withPrintScript(html), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // **The print policy, byte for byte what `?print=1` sends.** The script needs
      // `allow-scripts` and `allow-modals`; the `script-src` hash is what keeps the
      // report's *own* scripts blocked, which is the whole point of the sandbox.
      "Content-Security-Policy": reportCsp(true),
      // An ASCII-safe filename plus RFC 5987 for the real one: `Content-Disposition`
      // headers are latin-1, so a title with an accent silently truncates without
      // the `filename*` form.
      "Content-Disposition": contentDisposition(printableFilename(title, id)),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Appends PRINT_SCRIPT the way `?print=1` does: last, and without parsing a
 * document we did not write. A dangling `<script src="…` in a report absorbs any
 * attribute on our tag, so ours carries none.
 */
function withPrintScript(html: string): string {
  const tag = `<script>${PRINT_SCRIPT}</script>`;
  const bodyClose = html.lastIndexOf("</body>");
  if (bodyClose !== -1)
    return html.slice(0, bodyClose) + tag + html.slice(bodyClose);
  const htmlClose = html.lastIndexOf("</html>");
  if (htmlClose !== -1)
    return html.slice(0, htmlClose) + tag + html.slice(htmlClose);
  return html + tag;
}

/**
 * `Content-Disposition` with both filename forms.
 *
 * **The plain form is transliterated, not percent-encoded**, because a header
 * expecting latin-1 that receives `%20` shows the reader the escapes. The `filename*`
 * form carries the original for anything that reads UTF-8.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
