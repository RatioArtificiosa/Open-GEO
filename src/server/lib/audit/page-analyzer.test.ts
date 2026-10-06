/**
 * Parity tests for the streaming (htmlparser2) page analyzer against a
 * cheerio/DOM reference implementation — the exact logic the analyzer
 * replaced. Cheerio stays as a devDependency for this test only.
 */
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { analyzeHtml } from "@/server/lib/audit/page-analyzer";
import { normalizeUrl, isSameOrigin } from "@/server/lib/audit/url-utils";
import type { PageAnalysis, PageLink } from "@/server/lib/audit/types";
import type { StuffedTerm } from "@/server/lib/audit/keyword-density";

/**
 * Walks a parsed JSON-LD value for `@type`, the way a schema.org consumer would.
 *
 * **Independent of the streaming parser's scanner on purpose.** The parser reads
 * types with a tolerant regex because real-world JSON-LD is frequently invalid;
 * this walks actual JSON. The two agreeing on *valid* JSON is the check that has
 * meaning — if both used the same regex, agreement would prove nothing.
 */
function collectTypes(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectTypes(entry, into);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  // **Indexed, not cast.** The lint rule is right: narrowing `object` to
  // `Record<string, unknown>` asserts something we did not verify. `in` proves a
  // key exists on an object that JavaScript has already told us is one.
  if (!("@type" in value)) {
    // Still walk — the type may be nested under a child key.
    for (const nested of Object.values(value)) collectTypes(nested, into);
    return;
  }
  const type = value["@type"];
  for (const name of Array.isArray(type) ? type : [type]) {
    if (typeof name === "string" && !into.includes(name)) into.push(name);
  }
  for (const nested of Object.values(value)) collectTypes(nested, into);
}

/** The same walk over unparseable text, so the reference is not simply silent. */
function collectTypesFromText(body: string, into: string[]): void {
  for (const match of body.matchAll(
    /"@type"\s*:\s*"([A-Za-z][A-Za-z0-9]{0,63})"/g,
  )) {
    const name = match[1];
    if (name !== undefined && !into.includes(name)) into.push(name);
  }
}

/** The previous cheerio implementation, verbatim (minus passthrough fields). */
function analyzeHtmlWithCheerio(html: string, pageUrl: string): PageAnalysis {
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim();
  const metaDescription =
    $('meta[name="description"]').first().attr("content")?.trim() ?? "";
  const canonical = $('link[rel="canonical"]').first().attr("href") ?? null;
  const robotsMeta = $('meta[name="robots"]').first().attr("content") ?? null;
  const ogTitle =
    $('meta[property="og:title"]').first().attr("content") ?? null;
  const ogDescription =
    $('meta[property="og:description"]').first().attr("content") ?? null;
  const ogImage =
    $('meta[property="og:image"]').first().attr("content") ?? null;

  const h1s: string[] = [];
  $("h1").each((_, el) => {
    h1s.push($(el).text().trim());
  });

  /**
   * Heading text for every level, in document order.
   *
   * Written the way the DOM would do it — a per-level selector rather than a
   * streaming buffer — so it stays an **independent** reference for the
   * streaming parser to be checked against. A parity test whose two sides share
   * an implementation proves nothing, and this file exists precisely to catch
   * the streaming parser disagreeing with what a real DOM tree would produce.
   */
  const headings: Array<{ level: number; title: string }> = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const tag =
      "tagName" in el && typeof el.tagName === "string"
        ? el.tagName.toLowerCase()
        : null;
    if (!tag) return;
    const level = parseInt(tag.charAt(1), 10);
    if (isNaN(level)) return;
    headings.push({ level, title: $(el).text().trim() });
  });

  const headingOrder: number[] = headings.map((h) => h.level);

  const bodyClone = $("body").clone();
  bodyClone.find("script, style, noscript, svg").remove();
  const bodyText = bodyClone.text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;
  // **Deliberately not reimplemented here.** This helper is a cheerio-based reference
  // for what the streaming tokenizer extracts, so a second copy of the density rule
  // would be checking the rule against itself. The rule has its own tests, and the
  // fixtures here are prose rather than repetition.
  const stuffedTerms: StuffedTerm[] = [];

  const images: Array<{ src: string | null; alt: string | null }> = [];
  $("img").each((_, el) => {
    images.push({
      src: $(el).attr("src") ?? null,
      alt: $(el).attr("alt") ?? null,
    });
  });

  const linksByTarget = new Map<string, PageLink>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    if (/^(javascript:|mailto:|tel:|#)/.test(href)) return;
    const resolved = normalizeUrl(href, pageUrl);
    if (!resolved) return;
    if (linksByTarget.has(resolved)) return;
    const anchor = $(el).text().replace(/\s+/g, " ").trim().slice(0, 200);
    const rel = $(el).attr("rel")?.toLowerCase() ?? "";
    linksByTarget.set(resolved, {
      targetUrl: resolved,
      anchor: anchor || null,
      isInternal: isSameOrigin(resolved, pageUrl),
      isNofollow: rel.split(/\s+/).includes("nofollow"),
    });
  });

  let hasStructuredData = false;
  // **A MIME type matches on its essence, not the whole string.** The selector is
  // written the way a browser resolves it, which is what makes the
  // `charset=utf-8` case a real test rather than a regex coincidence.
  const schemaTypes: string[] = [];
  $("script").each((_, el) => {
    const type =
      ($(el).attr("type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (type !== "application/ld+json") return;
    hasStructuredData = true;
    // Read with a real `JSON.parse` where the block is valid — an independent
    // implementation is the whole point of this reference. The streaming parser
    // deliberately uses a tolerant scan, so the two agreeing on *valid* JSON is
    // the check that matters; on invalid JSON they are expected to differ and the
    // tolerance is tested directly rather than through parity.
    const body = $(el).html() ?? "";
    try {
      collectTypes(JSON.parse(body), schemaTypes);
    } catch {
      // Invalid JSON-LD is routine on the open web; the reference records the
      // types it can still see without it.
      collectTypesFromText(body, schemaTypes);
    }
  });

  const hreflangTags: string[] = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const hreflang = $(el).attr("hreflang");
    if (hreflang) hreflangTags.push(hreflang);
  });

  return {
    url: pageUrl,
    statusCode: 200,
    redirectUrl: null,
    responseTimeMs: 0,
    title,
    metaDescription,
    canonical,
    robotsMeta,
    ogTitle,
    ogDescription,
    ogImage,
    h1s,
    headings,
    headingOrder,
    wordCount,
    stuffedTerms,
    bodyText,
    images,
    links: Array.from(linksByTarget.values()),
    hasStructuredData,
    schemaTypes,
    hreflangTags,
  };
}

const PAGE_URL = "https://example.com/blog/post";

function expectParity(html: string) {
  const streamed = analyzeHtml(html, PAGE_URL, 200, 0);
  const reference = analyzeHtmlWithCheerio(html, PAGE_URL);
  expect(streamed).toEqual(reference);
}

describe("analyzeHtml parity with the DOM reference", () => {
  it("matches on a full, well-formed document", () => {
    expectParity(`<!DOCTYPE html>
      <html><head>
        <title> The  Title </title>
        <meta name="description" content="  A description.  ">
        <meta name="robots" content="index, follow">
        <meta property="og:title" content="OG Title">
        <meta property="og:description" content="OG Desc">
        <meta property="og:image" content="/og.png">
        <link rel="canonical" href="https://example.com/blog/post">
        <link rel="alternate" hreflang="en" href="/en">
        <link rel="alternate" hreflang="de" href="/de">
        <script type="application/ld+json">{"@type":"Article"}</script>
      </head><body>
        <h1>Main <em>Heading</em></h1>
        <h2>Sub</h2><h3>Deep</h3><h2>Sub 2</h2>
        <p>Some visible body text with <strong>bold words</strong> here.</p>
        <script>ignored();</script>
        <style>.x{}</style>
        <svg><title>icon</title><text>svg text</text></svg>
        <noscript><img src="/ns.png"><p>noscript text</p></noscript>
        <img src="/a.png" alt="A picture">
        <img src="/b.png" alt="">
        <img src="/c.png">
        <img alt="no src">
        <a href="/relative">Relative <span>link</span></a>
        <a href="https://example.com/relative">Duplicate target</a>
        <a href="https://other.example/x" rel="NoFollow sponsored">External</a>
        <a href="mailto:x@example.com">Mail</a>
        <a href="#frag">Fragment</a>
        <a href="javascript:void(0)">JS</a>
        <a href="/empty-anchor"><img src="/img-link.png" alt=""></a>
      </body></html>`);
  });

  it("matches on documents with no head, body, or title", () => {
    expectParity(
      `<h1>Bare fragment</h1><p>Just text and a <a href="/x">link</a>.</p>`,
    );
  });

  it("matches on an empty document", () => {
    expectParity("");
  });

  it("matches on a document with only a head", () => {
    expectParity(
      `<html><head><title>Head only</title><meta name="description" content="d"></head></html>`,
    );
  });

  it("matches with duplicate metas and titles (first wins)", () => {
    expectParity(`<html><head>
      <title>First</title><title>Second</title>
      <meta name="description" content="first desc">
      <meta name="description" content="second desc">
      <link rel="canonical" href="/first"><link rel="canonical" href="/second">
      </head><body><p>text</p></body></html>`);
  });

  it("matches on unclosed and misnested tags", () => {
    expectParity(`<html><body>
      <h1>Unclosed heading
      <p>Paragraph <b>bold <i>both</b> italic?</i>
      <a href="/one">first <a href="/two">second</a>
      <div>trailing text`);
  });

  it("matches on entity-heavy content", () => {
    expectParity(`<html><head><title>A &amp; B &lt;C&gt;</title></head>
      <body><h1>Caf&eacute; &quot;menu&quot;</h1>
      <p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>
      <a href="/x?a=1&amp;b=2">Query &amp; anchor</a></body></html>`);
  });

  it("matches heading order across nesting", () => {
    expectParity(`<body><h3>three</h3><div><h1>one</h1><section><h2>two</h2>
      <h6>six</h6></section></div><h4>four</h4></body>`);
  });

  it("matches word counts with whitespace-heavy markup", () => {
    expectParity(`<body>
      <p>
        one
        two    three
      </p>
      <ul><li>four</li><li>five</li></ul>
    </body>`);
  });

  it("keeps an inline element inside a heading as one heading", () => {
    // **The specific failure mode of a naive close-on-any-tag buffer.** Closing
    // the heading on the first `onclosetag` would record `<h2>Reach <b>10k</b>
    // users</h2>` as two headings, the second holding just `10k` — and a citability
    // rubric asking "what fraction of subheadings are questions?" would then see a
    // subheading that is the word "10k". The parity check catches it because the
    // DOM reference counts one heading and a close-on-any-tag parser counts two.
    expectParity(
      `<body><h2>Reach <b>10k</b> users</h2><h3>How it works</h3></body>`,
    );

    const { headings } = analyzeHtml(
      `<body><h2>Reach <b>10k</b> users</h2><h3>How it works</h3></body>`,
      "https://example.com/",
      200,
      0,
    );
    expect(headings).toEqual([
      { level: 2, title: "Reach 10k users" },
      { level: 3, title: "How it works" },
    ]);
  });

  it("records heading text for every level, not just h1", () => {
    // The citability rubric needs h2/h3 *text* to count question headings, and
    // the old parser captured it for h1 only — so this was the data missing for
    // the whole question-headers factor, not a refinement of it.
    const { headings, headingOrder } = analyzeHtml(
      `<body><h1>Title</h1><h2>Why?</h2><h3>How?</h3><h4>Deep?</h4></body>`,
      "https://example.com/",
      200,
      0,
    );

    expect(headings.map((h) => h.level)).toEqual([1, 2, 3, 4]);
    expect(headings.map((h) => h.title)).toEqual([
      "Title",
      "Why?",
      "How?",
      "Deep?",
    ]);
    // The list and the order array are built from the same walk, so they can
    // never disagree about how many headings the page has.
    expect(headingOrder).toEqual(headings.map((h) => h.level));
  });

  it("derives h1s from the same walk, so the two cannot drift", () => {
    // `h1s` is kept only because four existing callers read it. Two independent
    // accumulators is how they would drift; this pins that they are the same data.
    const { h1s, headings } = analyzeHtml(
      `<body><h2>no title here</h2><h1>  Real Title  </h1><h1>Second</h1></body>`,
      "https://example.com/",
      200,
      0,
    );

    expect(h1s).toEqual(["Real Title", "Second"]);
    expect(h1s).toEqual(
      headings.filter((h) => h.level === 1).map((h) => h.title),
    );
  });

  it("does not let an unclosed heading swallow the ones after it", () => {
    // Malformed markup is common, and the buffer is **single, not a stack** — so
    // a new heading replaces an unclosed one. Without that, everything after a
    // stray `<h2>` would arrive as one heading's text, and the question-header
    // ratio would be computed from a page that does not exist.
    //
    // **The unclosed `<h2>` is itself dropped**, which is the same as the DOM
    // reference: cheerio's `$("h2")` never matches a tag that was never closed.
    // Keeping it would make this parser disagree with a real DOM tree, and the
    // heading count would differ from what a browser renders — the same
    // disagreement the `headingOrder` array is checked against.
    const { headings } = analyzeHtml(
      `<body><h2>First<h3>Second</h3><h4>Third</h4></body>`,
      "https://example.com/",
      200,
      0,
    );

    expect(headings).toEqual([
      { level: 3, title: "Second" },
      { level: 4, title: "Third" },
    ]);
  });

  it("records a heading left open at end of document", () => {
    // The mirror case, and the reason the EOF flush exists: `headingOrder` recorded
    // this heading's level the moment the tag opened, so dropping its text would
    // leave the two arrays disagreeing about how many headings the page has — and
    // a count that disagrees with the list is worse than either being wrong alone.
    const { headings, headingOrder } = analyzeHtml(
      `<body><h1>Complete</h1><h2>Never closed`,
      "https://example.com/",
      200,
      0,
    );

    expect(headings).toEqual([
      { level: 1, title: "Complete" },
      { level: 2, title: "Never closed" },
    ]);
    expect(headingOrder).toEqual([1, 2]);
  });
});

describe("analyzeHtml extraction caps", () => {
  it("caps links and images per page", () => {
    const links = Array.from(
      { length: 1_100 },
      (_, i) => `<a href="/p/${i}">link ${i}</a>`,
    ).join("");
    const images = Array.from(
      { length: 1_100 },
      (_, i) => `<img src="/i/${i}.png">`,
    ).join("");
    const analysis = analyzeHtml(
      `<body>${links}${images}</body>`,
      "https://example.com/",
      200,
      100,
    );
    expect(analysis.links).toHaveLength(1_000);
    expect(analysis.images).toHaveLength(1_000);
  });

  it("carries the terms the page repeats, from HTML through to the analysis", () => {
    // **The wiring, not the rule.** The density rule has its own tests, and the fixtures
    // in this file are prose, so a hardcoded `stuffedTerms: []` in the analyzer would
    // satisfy every one of them. This is the case that would not: repetition in real
    // HTML has to survive the tokenizer and the word count to reach the reporters.
    // The trailing space inside the first paragraph is load-bearing: block boundaries
    // are currently concatenated with no separator (see the note on `bodyParts` in
    // `page-analyzer.ts`), so without it the last `plumber` would merge with `word0`
    // and this test would be measuring that defect instead of the density wiring.
    const filler = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const analysis = analyzeHtml(
      `<body><p>${Array.from({ length: 20 }, () => "plumber").join(" ")} </p><p>${filler}</p></body>`,
      "https://example.com/plumbing",
      200,
      100,
    );

    expect(analysis.stuffedTerms).toHaveLength(1);
    expect(analysis.stuffedTerms[0]?.term).toBe("plumber");
    expect(analysis.stuffedTerms[0]?.count).toBe(20);
    // 20 uses in 60 counted words.
    expect(analysis.stuffedTerms[0]?.density).toBeCloseTo(20 / 60, 5);
  });
});
