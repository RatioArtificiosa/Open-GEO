/**
 * HTML page analyzer using htmlparser2's streaming tokenizer.
 *
 * Extracts SEO-relevant data from a page's HTML: title, meta description,
 * headings, images, links, canonical, OG tags, structured data, robots meta,
 * word count, hreflang.
 *
 * Deliberately NOT a DOM parser: the previous cheerio implementation built a
 * full DOM (~5-10x the HTML's size) per page, and with 25 concurrent parses
 * on a 128MB isolate that was the audit engine's dominant OOM cause. The
 * tokenizer keeps only the accumulated text and extracted fields in memory.
 */
import { Parser } from "htmlparser2";
import { normalizeUrl, isSameOrigin } from "./url-utils";
import { findStuffedTerms } from "./keyword-density";
import type { PageAnalysis, PageLink } from "./types";
import {
  flushSchemaTypes,
  isJsonLdScript,
} from "@/server/lib/audit/schema-types";

const SKIPPED_LINK_PROTOCOLS = /^(javascript:|mailto:|tel:|#)/;
/** Subtrees whose text is not visible content. */
const NON_CONTENT_TAGS = new Set(["script", "style", "noscript", "svg"]);
/**
 * Elements whose boundaries are whitespace between words.
 *
 * Joining text nodes directly is `textContent`, which has no separators:
 * `<p>plumber</p><p>rates</p>` becomes `plumberrates`. Every consumer of `bodyText`
 * wants `innerText` instead, which is what a browser lays out and what a reader sees, so
 * `wordCount` ran one short per seam (thin-content findings), two terms merged at a
 * boundary (density findings), and `contentHash` covered a string nobody would read.
 *
 * Inline tags are deliberately absent. `<b>plum</b>ber` is one word, and separating at an
 * inline boundary would split it into two.
 */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);
const HEADING_LEVELS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};
const MAX_ANCHOR_CHARS = 200;

/**
 * Appends a heading's collected text to `headings`, if there is one open.
 *
 * A single place pushes, so the EOF flush and the close-tag path cannot disagree
 * about trimming or about which fields are recorded. Returns nothing: the
 * caller owns the buffer's lifecycle, because clearing it inside a helper would
 * need to reassign a `let` the parser closures also write.
 */
function flushOpenHeading(
  headings: Array<{ level: number; title: string }>,
  open: { level: number; text: string[] } | null,
): void {
  if (open === null) return;
  headings.push({ level: open.level, title: open.text.join("").trim() });
}

/**
 * Per-page caps on the extracted collections. Crawler-trap and mega-menu
 * pages can carry thousands of links/images per page, and crawled pages sit
 * in memory in 25-page persist batches — uncapped collections were part of
 * the audit engine's exceededMemory profile. Counts derived from these
 * arrays saturate at the cap on such pathological pages.
 */
const MAX_EXTRACTED_LINKS = 1_000;
const MAX_EXTRACTED_IMAGES = 1_000;

interface OpenAnchor {
  href: string;
  rel: string;
  text: string[];
}

/**
 * Analyze an HTML string and extract all SEO-relevant data.
 */
export function analyzeHtml(
  html: string,
  pageUrl: string,
  statusCode: number,
  responseTimeMs: number,
  redirectUrl: string | null = null,
): PageAnalysis {
  let title: string | null = null;
  let titleDepth = 0;
  let titleDone = false;
  // parse5 (the old DOM path) treats <noscript> content as raw text when
  // scripting is enabled; skip element extraction inside it to match.
  let noscriptDepth = 0;
  let metaDescription: string | null = null;
  let canonical: string | null = null;
  let robotsMeta: string | null = null;
  let ogTitle: string | null = null;
  let ogDescription: string | null = null;
  let ogImage: string | null = null;
  let hasStructuredData = false;
  const hreflangTags: string[] = [];

  const headingOrder: number[] = [];
  /**
   * Heading text, paired with its level, in document order.
   *
   * **This replaces an h1-only buffer, and the h1 array is kept as a derived
   * view because four existing callers read it.** The old code opened a buffer
   * only for `h1`, so h2–h6 text was never captured — and `crawlPage` reduced
   * even the h1 text to a *count*, discarding the string. Everything needed to
   * answer "does this page lead with an answer" was therefore already in the
   * parser and thrown away one layer up.
   *
   * One buffer, not a stack: HTML forbids nesting one heading inside another, so
   * a new heading simply replaces an unclosed one rather than nesting. That
   * matches how `headingOrder` already behaves — it pushes on open without
   * tracking depth — so the two arrays cannot disagree about how many headings
   * a page has.
   */
  const headings: Array<{ level: number; title: string }> = [];
  let openHeading: { level: number; text: string[] } | null = null;

  /**
   * The body of the JSON-LD `<script>` currently open, or null.
   *
   * **Captured for the same reason headings are: the bytes are already being
   * tokenized.** The parser walks the whole document including script bodies, so
   * the `@type` values the citability rubric asks for were passing through and
   * being dropped — the fourth instance of the same shape in this codebase.
   *
   * Bounded rather than accumulated without limit: a crawler-trap page can carry
   * megabytes of JSON-LD, and this is a list of *type names*, not a document.
   */
  let openLdJson: string[] | null = null;

  /**
   * Schema.org types found across every JSON-LD block on the page, in order and
   * deduplicated. Empty means *none were found*, which is a different claim from
   * *no JSON-LD was present* — the rubric scores the first and treats the second
   * as unmeasured.
   */
  const schemaTypes: string[] = [];

  const images: Array<{ src: string | null; alt: string | null }> = [];
  const linksByTarget = new Map<string, PageLink>();
  let openAnchor: OpenAnchor | null = null;

  // Visible text: prefer text inside an explicit <body>; when the document
  // never opens one (fragments), fall back to all non-head text. Both
  // exclude NON_CONTENT_TAGS subtrees.
  let suppressDepth = 0;
  let bodyDepth = 0;
  let headDepth = 0;
  let sawBody = false;
  const bodyParts: string[] = [];
  const fallbackParts: string[] = [];

  const handleMetaTag = (attribs: Record<string, string>) => {
    const content = attribs["content"];
    if (attribs["name"] === "description") {
      metaDescription ??= content?.trim() ?? "";
    } else if (attribs["name"] === "robots") {
      robotsMeta ??= content ?? null;
    } else if (attribs["property"] === "og:title") {
      ogTitle ??= content ?? null;
    } else if (attribs["property"] === "og:description") {
      ogDescription ??= content ?? null;
    } else if (attribs["property"] === "og:image") {
      ogImage ??= content ?? null;
    }
  };

  const handleLinkTag = (attribs: Record<string, string>) => {
    if (attribs["rel"] === "canonical") {
      canonical ??= attribs["href"] ?? null;
    } else if (attribs["rel"] === "alternate" && attribs["hreflang"]) {
      hreflangTags.push(attribs["hreflang"]);
    }
  };

  const closeAnchor = () => {
    if (!openAnchor) return;
    const { href, rel, text } = openAnchor;
    openAnchor = null;
    if (linksByTarget.size >= MAX_EXTRACTED_LINKS) return;
    const resolved = normalizeUrl(href, pageUrl);
    if (!resolved || linksByTarget.has(resolved)) return;
    const anchor = text
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_ANCHOR_CHARS);
    linksByTarget.set(resolved, {
      targetUrl: resolved,
      anchor: anchor || null,
      isInternal: isSameOrigin(resolved, pageUrl),
      isNofollow: rel.split(/\s+/).includes("nofollow"),
    });
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (NON_CONTENT_TAGS.has(name)) {
          suppressDepth += 1;
        }
        if (name === "noscript") noscriptDepth += 1;
        if (noscriptDepth > 0) return;
        switch (name) {
          case "title":
            // Ignore <title> inside <svg> — only the document title counts.
            if (!titleDone && suppressDepth === 0) {
              titleDepth += 1;
              if (title === null) title = "";
            }
            break;
          case "head":
            headDepth += 1;
            break;
          case "body":
            bodyDepth += 1;
            sawBody = true;
            break;
          case "meta":
            handleMetaTag(attribs);
            break;
          case "link":
            handleLinkTag(attribs);
            break;
          case "img":
            if (images.length < MAX_EXTRACTED_IMAGES) {
              images.push({
                src: attribs["src"] ?? null,
                alt: "alt" in attribs ? attribs["alt"] : null,
              });
            }
            break;
          case "script":
            if (isJsonLdScript(attribs["type"])) {
              hasStructuredData = true;
              // Capturing the body so `@type` can be read from it. A missing or
              // malformed `@type` is why this is best-effort and never throws:
              // the page still has structured data, we simply cannot name its type.
              if (openLdJson === null) openLdJson = [];
            }
            break;
          case "a": {
            // HTML forbids nested <a>; browsers implicitly close the open
            // one, and the tokenizer has no tree correction, so mirror that.
            closeAnchor();
            const href = attribs["href"];
            if (href && !SKIPPED_LINK_PROTOCOLS.test(href)) {
              openAnchor = {
                href,
                rel: attribs["rel"]?.toLowerCase() ?? "",
                text: [],
              };
            }
            break;
          }
        }
        const headingLevel = HEADING_LEVELS[name];
        if (headingLevel !== undefined) {
          headingOrder.push(headingLevel);
          // Replaces an unclosed heading rather than nesting: HTML forbids one
          // heading inside another, and a buffer left open by malformed markup
          // would otherwise swallow every following heading into one string.
          openHeading = { level: headingLevel, text: [] };
        }
        // A block boundary is a word boundary. Pushed at the *open* rather than the
        // close, because the tokenizer's open order is the order text arrives in and a
        // void element such as `<br>` never closes. See `BLOCK_TAGS`.
        if (BLOCK_TAGS.has(name)) {
          if (bodyDepth > 0) bodyParts.push(" ");
          else if (headDepth === 0) fallbackParts.push(" ");
        }
      },
      ontext(text) {
        // **Before the `suppressDepth` guard.** `script` is in
        // `NON_CONTENT_TAGS`, so a JSON-LD body would otherwise be discarded
        // before anything could read it — the same way heading text used to die.
        if (openLdJson !== null) {
          openLdJson.push(text);
          return;
        }
        if (suppressDepth > 0) return;
        if (titleDepth > 0) {
          if (title !== null) title += text;
          return;
        }
        if (openHeading) openHeading.text.push(text);
        if (openAnchor) openAnchor.text.push(text);
        if (bodyDepth > 0) {
          bodyParts.push(text);
        } else if (headDepth === 0) {
          fallbackParts.push(text);
        }
      },
      onclosetag(name) {
        if (NON_CONTENT_TAGS.has(name) && suppressDepth > 0) {
          suppressDepth -= 1;
        }
        if (name === "noscript" && noscriptDepth > 0) {
          noscriptDepth -= 1;
          return;
        }
        if (noscriptDepth > 0) return;
        if (name === "title" && titleDepth > 0) {
          titleDepth -= 1;
          if (titleDepth === 0) titleDone = true;
        }
        if (name === "head" && headDepth > 0) headDepth -= 1;
        if (name === "body" && bodyDepth > 0) bodyDepth -= 1;
        if (name === "a") closeAnchor();
        /**
         * Closes the open heading, **only when the closing tag is a heading.**
         *
         * An earlier version closed on every `onclosetag`, which pushed a
         * heading the instant any child element ended — so `<h1>Total <b>3</b>`
         * was recorded as two headings, the second holding `3`. The level is
         * checked rather than the name because the name is lowercased by the
         * tokenizer and `HEADING_LEVELS` is the single source of truth for
         * which tags count as headings.
         */
        const closingLevel = HEADING_LEVELS[name];
        if (closingLevel !== undefined && openHeading?.level === closingLevel) {
          flushOpenHeading(headings, openHeading);
          openHeading = null;
        }
        if (name === "script" && openLdJson !== null) {
          flushSchemaTypes(schemaTypes, openLdJson);
          openLdJson = null;
        }
      },
    },
    // Defaults (non-XML mode): lowercased tag/attribute names, decoded
    // entities — matching what the DOM-based implementation saw.
  );
  parser.write(html);
  parser.end();

  const rawText = (sawBody ? bodyParts : fallbackParts).join("");
  const bodyText = rawText.replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;
  // Computed here, where the text is, and reduced to a capped list before the page
  // leaves the analyzer. See `keyword-density.ts` for why this is local rather than
  // DataForSEO's `on_page/keyword_density`.
  const stuffedTerms = findStuffedTerms(bodyText);

  /**
   * An unclosed heading at EOF still counts. `headingOrder` already recorded its
   * level when the tag opened, so dropping the text here would leave the two
   * disagreeing about how many headings the page has — and a count that
   * disagrees with the list is worse than either being wrong alone.
   *
   * **A function rather than an inline `if`.** Every write to `openHeading`
   * happens inside a parser callback, and TypeScript's control-flow analysis
   * treats a closure's assignments as invisible — so at this point it narrows
   * `openHeading` to `null` and `openHeading.level` does not typecheck. Reading
   * it through a function boundary is the honest description of what this is:
   * a state the analysis cannot follow, so it is asked for rather than assumed.
   */
  flushOpenHeading(headings, openHeading);

  return {
    url: pageUrl,
    statusCode,
    redirectUrl,
    responseTimeMs,
    title: (title ?? "").trim(),
    metaDescription: metaDescription ?? "",
    canonical,
    robotsMeta,
    ogTitle,
    ogDescription,
    ogImage,
    // **Derived, not independently tracked.** Filtering `headings` by level is
    // the same list `headingOrder` was built from, so the two cannot drift —
    // which the old parallel h1 buffer could, and did for nested markup.
    h1s: headings.filter((h) => h.level === 1).map((h) => h.title),
    headings,
    headingOrder,
    wordCount,
    bodyText,
    stuffedTerms,
    images,
    links: Array.from(linksByTarget.values()),
    hasStructuredData,
    schemaTypes,
    hreflangTags,
  };
}
