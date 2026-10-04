import { describe, expect, it } from "vitest";
import { analyzeHtml } from "@/server/lib/audit/page-analyzer";

/**
 * Schema.org type extraction, at the level of `analyzeHtml`'s output.
 *
 * **Separate from the parity file on purpose.** Those tests compare the streaming
 * parser against a cheerio reference and must keep both implementations honest
 * about the same documents. These tests are about one decision — *what does a
 * JSON-LD block declare, and what happens when the block is broken* — and they
 * deliberately feed the parser documents a real DOM would reject or normalise
 * away, because **the malformed cases are the ones a parity check cannot cover
 * and the ones that decide whether this field is worth having.**
 */

const parse = (html: string) =>
  analyzeHtml(html, "https://example.com/", 200, 0);

describe("analyzeHtml schema.org extraction", () => {
  it("reads the type out of JSON-LD, not just that a block exists", () => {
    // The rubric's schema-coverage factor needs the *type*; `hasStructuredData`
    // only ever said "there is a script". The bytes were already tokenized.
    const { schemaTypes, hasStructuredData } = parse(
      `<body><script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Article","headline":"Hi"}
      </script></body>`,
    );

    expect(hasStructuredData).toBe(true);
    expect(schemaTypes).toEqual(["Article"]);
  });

  it("recognises a JSON-LD script carrying a MIME parameter", () => {
    // `type="application/ld+json; charset=utf-8"` is legal and is what several
    // CMS templating layers emit. Exact equality reported **no structured data
    // at all** for those pages — a false finding about a page that had it, and
    // being right about this is the entire purpose of the field.
    const { schemaTypes, hasStructuredData } = parse(
      `<body><script type="application/ld+json; charset=utf-8">
        {"@type":"FAQPage"}
      </script></body>`,
    );

    expect(hasStructuredData).toBe(true);
    expect(schemaTypes).toEqual(["FAQPage"]);
  });

  it("reads a differently-cased MIME type", () => {
    // The tokenizer lowercases attribute *names* but not their values.
    const { schemaTypes } = parse(
      `<body><script type="APPLICATION/LD+JSON">{"@type":"Book"}</script></body>`,
    );

    expect(schemaTypes).toEqual(["Book"]);
  });

  it("reads an array-valued @type, since that is how one page declares two roles", () => {
    const { schemaTypes } = parse(
      `<body><script type="application/ld+json">
        {"@graph":[{"@type":"Article"},{"@type":"FAQPage"}]}
      </script></body>`,
    );

    expect(schemaTypes).toEqual(["Article", "FAQPage"]);
  });

  it("keeps both types from a multi-entry @type array", () => {
    // **Why the array branch has its own test.** A `@graph` block listing two
    // roles is the normal way one page declares both, and reducing it to the first
    // entry would report an FAQPage page as an Article — a *wrong* finding about
    // what the page is, rather than a missing one.
    const { schemaTypes } = parse(
      `<body><script type="application/ld+json">
        {"@type":["Product","FAQPage"]}
      </script></body>`,
    );

    expect(schemaTypes).toEqual(["Product", "FAQPage"]);
  });

  it("reports a repeated type once, however many blocks declare it", () => {
    // A page cannot be more citatable for saying `Article` three times, and a
    // duplicate list would inflate any count a caller derives from the length.
    //
    // **This caught a real bug.** The close-tag path pushed types directly and
    // only deduplicated *within* one block, so a multi-block page came back as
    // `["Article", "Article", "WebPage"]`. Routing every flush through
    // `flushSchemaTypes` is what fixed it.
    const { schemaTypes } = parse(
      `<body>
        <script type="application/ld+json">{"@type":"Article"}</script>
        <script type="application/ld+json">{"@type":"Article","@id":"#b"}</script>
        <script type="application/ld+json">{"@type":"WebPage"}</script>
      </body>`,
    );

    expect(schemaTypes).toEqual(["Article", "WebPage"]);
  });

  it("still reports a type when the JSON-LD around it is invalid", () => {
    // Structured data on the open web is frequently malformed — trailing commas,
    // single quotes. A `JSON.parse` would throw and cost the page its entire
    // schema reading, which is the wrong trade for a field whose only job is to
    // say what the page declares itself to be.
    const { schemaTypes } = parse(
      `<body><script type="application/ld+json">
        {'@type': 'Product', name: 'Widget',}
      </script></body>`,
    );

    expect(schemaTypes).toEqual(["Product"]);
  });

  it("does not invent a type out of arbitrary page text", () => {
    // The scanner reads `@type` keys; it must not treat any quoted word as one.
    const { schemaTypes } = parse(
      `<body><script type="application/ld+json">
        {"name":"A guide to @type and structured data","@type":"TechArticle"}
      </script></body>`,
    );

    expect(schemaTypes).toEqual(["TechArticle"]);
  });

  it("refuses a type name that is not one, rather than trusting the key", () => {
    // The bounded pattern is the guard. An unbounded one would accept a value
    // that is not a type name at all — a URL, a sentence, a blob of page text —
    // and the rubric would then be scoring on whatever a data field happened to
    // hold. The name has to look like a name.
    const { schemaTypes } = parse(
      `<body><script type="application/ld+json">
        {"@type":"https://example.com/not-a-type-name-at-all","@type2":"Nope"}
      </script></body>`,
    );

    // The URL is not a plausible schema.org type, so nothing is reported — and
    // crucially the scan does not fall back to treating the whole value as a name.
    expect(schemaTypes).toEqual([]);
  });

  it("reads the types out of a JSON-LD block that is never closed", () => {
    // A truncated page is exactly the case where a silently-dropped reading turns
    // "we could not finish parsing" into "this page has no structured data".
    //
    // **No EOF flush is needed for this, and that was worth finding out.** A first
    // version added one; removing it changed nothing, because htmlparser2 fires
    // `onclosetag` for an unterminated element at EOF — so the flush was dead code
    // claiming to handle a case it never handled. **Dead code that documents a
    // guarantee it does not provide is worse than no code**, because the next
    // reader trusts the comment. Deleted rather than kept "for safety".
    const { schemaTypes, hasStructuredData } = parse(
      `<body><script type="application/ld+json">{"@type":"Recipe"`,
    );

    expect(hasStructuredData).toBe(true);
    expect(schemaTypes).toEqual(["Recipe"]);
  });

  it("reports no types for a page with no JSON-LD at all", () => {
    // Empty, with `hasStructuredData: false`. That is a *finding*, and it is a
    // different finding from a page that was never parsed — which is why the
    // crawler-level result carries an empty list rather than a null.
    const { schemaTypes, hasStructuredData } = parse(
      `<body><h1>Plain page</h1></body>`,
    );

    expect(hasStructuredData).toBe(false);
    expect(schemaTypes).toEqual([]);
  });

  it("ignores a script that is not JSON-LD, however suggestive its body is", () => {
    // A page can mention `@type` in any script it likes. Only the *type attribute*
    // makes a block structured data, and reading types from an analytics snippet
    // would report schema coverage the page does not have.
    const { schemaTypes, hasStructuredData } = parse(
      `<body><script type="text/javascript">
        var config = {"@type":"Article"};
      </script></body>`,
    );

    expect(hasStructuredData).toBe(false);
    expect(schemaTypes).toEqual([]);
  });
});
