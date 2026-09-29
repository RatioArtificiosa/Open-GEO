import { describe, expect, it } from "vitest";
import { listNiches, nichePath, resolveNiche } from "./programmaticNiches";
import { HEADLINE_IS_FREE, nicheJsonLd, serialiseJsonLd } from "./nicheJsonLd";

/**
 * Programmatic SEO for the free tool.
 *
 * The route file is the easy part. What decides whether this is an asset or a
 * liability is **which slugs exist at all** — an unbounded page factory with a
 * swapped noun is a doorway-page generator, which Google names explicitly. So
 * most of these tests are about the registry refusing.
 */

describe("resolveNiche", () => {
  it("serves a curated niche", () => {
    const result = resolveNiche("dental");
    expect(result.kind).toBe("found");
    expect(result.kind === "found" && result.niche.label).toBe(
      "Dental practices",
    );
  });

  it("404s an unknown slug rather than rendering a shell", () => {
    // The whole point of the whitelist. A rendered page here is a doorway page.
    expect(resolveNiche("asdfgh").kind).toBe("not-found");
  });

  it("404s nothing at all", () => {
    expect(resolveNiche(undefined).kind).toBe("not-found");
    expect(resolveNiche("").kind).toBe("not-found");
  });

  it("is case- and shape-insensitive, so a nickname is not a dead end", () => {
    // A visitor who typed the URL slightly wrong is not a crawler, and a page
    // that 404s for its own nickname loses a share to a typo.
    for (const input of ["Dental", "  dental  ", "DENTAL", "dental/"]) {
      expect(resolveNiche(input).kind).toBe("found");
    }
  });

  it("redirects a known near-miss instead of 404ing it", () => {
    // Safe alongside the whitelist: a redirect can only target a page that
    // already exists, so it cannot create an indexable surface.
    const result = resolveNiche("dentistry");
    expect(result.kind).toBe("redirect");
    expect(result.kind === "redirect" && result.to).toBe("dental");
    expect(resolveNiche("plumbers").kind).toBe("redirect");
  });

  it("does not suggest a page on a mere string similarity", () => {
    // A fuzzy matcher over a small set happily maps `mental` → `dental`. A 404
    // is a better outcome than landing a visitor on the wrong industry.
    expect(resolveNiche("mental").kind).toBe("not-found");
    expect(resolveNiche("sendtal").kind).toBe("not-found");
  });

  it("only ever redirects to a slug that exists", () => {
    for (const niche of listNiches()) {
      for (const alias of [
        "dentistry",
        "plumbers",
        "attorneys",
        "accountants",
        "realtors",
      ]) {
        const result = resolveNiche(alias);
        if (result.kind === "redirect") {
          expect(listNiches().some((n) => n.slug === result.to)).toBe(true);
        }
      }
      expect(nichePath(niche.slug)).toBe(`/tools/ai-visibility/${niche.slug}`);
    }
  });

  it("gives every niche something specific to say", () => {
    // A curated entry with an empty or generic sentence is a doorway page with
    // extra steps, so the sentence is the thing checked.
    for (const niche of listNiches()) {
      expect(niche.whatAiIsAsked.length).toBeGreaterThan(80);
      expect(niche.label.length).toBeGreaterThan(0);
    }
  });

  it("keeps unique slugs", () => {
    const slugs = listNiches().map((n) => n.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("nicheJsonLd", () => {
  const niche = listNiches()[0];
  if (niche === undefined) throw new Error("the registry must not be empty");

  it("declares a WebApplication, not an FAQPage", () => {
    // `FAQPage` is wrong here and the error is penalised, not cosmetic: the
    // page's questions describe what *AI engines* are asked, they are not the
    // page's own Q&A, and marking them up as such tells a search engine
    // something untrue about the page.
    const serialised = JSON.stringify(
      nicheJsonLd({ niche, origin: "https://opengeo.so" }),
    );
    expect(serialised).not.toContain("FAQPage");
    expect(serialised).toContain("WebApplication");
  });

  it("uses the niche's own sentence as the description", () => {
    // A description written for a crawler and different from the visible text is
    // the doorway-page pattern the registry exists to prevent.
    const graph = nicheJsonLd({ niche, origin: "https://opengeo.so" })[
      "@graph"
    ];
    expect(graph).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          "@type": "WebPage",
          description: niche.whatAiIsAsked,
        }),
      ]),
    );
  });

  it("builds absolute URLs from any origin, including a self-hosted one", () => {
    const graph = nicheJsonLd({
      niche,
      origin: "http://localhost:3000/",
    })["@graph"];
    // A self-hosted install must serve on its own domain, and the trailing slash
    // is stripped rather than doubled. Narrowed with the same array check the
    // other graph assertions use, rather than by asserting the whole graph shape.
    expect(Array.isArray(graph)).toBe(true);
    expect(Array.isArray(graph) ? graph[0] : null).toEqual(
      expect.objectContaining({
        url: `http://localhost:3000${nichePath(niche.slug)}`,
      }),
    );
  });

  it("claims free access, because CL-141 made that true", () => {
    // The headline number needs no signup. If that ever changes this has to
    // change with it, and it is asserted against the shared constant rather than
    // a literal that can drift.
    const graph = nicheJsonLd({ niche, origin: "https://opengeo.so" })[
      "@graph"
    ];
    expect(HEADLINE_IS_FREE).toBe(true);
    expect(graph).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          isAccessibleForFree: true,
          // Asserted concretely rather than with `expect.anything()`, which
          // returns `any` and so weakens the check it appears to make.
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        }),
      ]),
    );
  });
});

describe("serialiseJsonLd", () => {
  it("cannot be broken out of by a hostile niche label", () => {
    // The payload is embedded in a <script> tag and the niche name reaches it
    // from the URL. An unescaped `</script>` would close the tag early and turn
    // page content into markup — reachable by anyone typing a URL.
    const hostile = { name: "</script><img src=x onerror=alert(1)>" };
    const serialised = serialiseJsonLd(hostile);
    expect(serialised).not.toContain("</script>");
    expect(serialised).toContain("\\u003c");
  });

  it("still parses back to the same value", () => {
    // Escaping must not corrupt the payload, or the structured data is invalid
    // for a reason no test above would notice.
    const value = {
      "@type": "WebPage",
      name: "AI Visibility for Dental practices",
    };
    expect(JSON.parse(serialiseJsonLd(value))).toEqual(value);
  });
});
