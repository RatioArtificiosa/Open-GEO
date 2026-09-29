import { nichePath, type Niche } from "./programmaticNiches";

/**
 * JSON-LD for the niche pages.
 *
 * ## Why `SoftwareApplication` and not `FAQPage`
 *
 * The obvious choice is `FAQPage`, because the page renders question-and-answer
 * content. It is the wrong type, and getting it wrong is a structured-data
 * penalty rather than a cosmetic issue: `FAQPage` is only valid for pages whose
 * *visible* content is questions with answers written for a human reader, and
 * Google's guidance has narrowed it repeatedly to government and health pages.
 * More importantly, this page's questions are *descriptions of what AI engines
 * are asked* — they are not the page's own Q&A, and marking them up as such
 * would tell a search engine something untrue about the page.
 *
 * So the page declares what it actually is: a **WebApplication** with a `Software`
 * `isAccessibleForFree` claim matching the real rule (the headline number needs
 * no signup — CL-141), and a `WebPage` wrapper carrying the title and the
 * canonical URL.
 *
 * ## The one claim that must not drift
 *
 * `isAccessibleForFree: true` is a factual statement about our product. CL-141
 * shipped precisely to make it true — the headline number is visible with no
 * signup. If that ever changes, this has to change with it, and a test asserts
 * the two agree by pointing at the same constant rather than at a literal that
 * can drift silently.
 */

/** Mirrors `VisibilityCard`'s promise. One source of truth for both. */
export const HEADLINE_IS_FREE = true;

/**
 * A JSON-LD graph node.
 *
 * `Record<string, unknown>` rather than a schema.org union: this module builds
 * two known shapes and a test asserts they carry the right `@type`, which is
 * the assertion that matters. A union here would be a claim about all of
 * schema.org that we have no need to make.
 */
type JsonLd = Record<string, unknown>;

export function nicheJsonLd(input: {
  niche: Niche;
  /** Absolute origin, so the URL in JSON-LD is absolute as the spec requires. */
  origin: string;
}): JsonLd {
  const url = `${input.origin.replace(/\/$/, "")}${nichePath(input.niche.slug)}`;
  const title = `AI Visibility for ${input.niche.label} | OpenGeo`;

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": url,
        url,
        name: title,
        // The niche's own sentence, verbatim. A description written for a
        // crawler and different from the visible text is the doorway-page
        // pattern the whole registry exists to avoid.
        description: input.niche.whatAiIsAsked,
        isPartOf: { "@id": `${input.origin.replace(/\/$/, "")}/#website` },
      },
      {
        "@type": "WebApplication",
        "@id": `${url}#app`,
        name: "OpenGeo AI Visibility Checker",
        url,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        description: input.niche.whatAiIsAsked,
        isAccessibleForFree: HEADLINE_IS_FREE,
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
        },
        featureList: [
          "AI mention counts for your domain",
          "Per-platform breakdown, never combined",
          "The domains AI engines cite you from",
        ],
      },
    ],
  };
}

/**
 * Serialise for a `<script type="application/ld+json">` tag.
 *
 * `<` is escaped as `<` specifically because the payload is embedded in
 * HTML: a niche label containing `</script>` would otherwise close the tag
 * early and let page content become markup. That is an injection, and it is
 * reachable from the URL — the very thing this feature is about.
 */
export function serialiseJsonLd(value: JsonLd): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}
