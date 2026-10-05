import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/legal-page";
import { buildPageSeo } from "@/lib/seo";

/**
 * Notices — licence, copyright and upstream attribution.
 *
 * ## Why this page exists
 *
 * All of this was on the homepage, in two places a prospect reads while deciding
 * whether to subscribe:
 *
 * - *"Copyright © 2026 Ben Senescu, preserved intact — it is a derivative work of
 *   OpenSEO."* as the first of the three open-source facts, and
 * - *"© 2026 Every App, Inc."* under the final call to action, which made a legal
 *   identity the last thing on the page.
 *
 * **None of it goes away — it moves.** An MIT derivative has to carry its licence and
 * its NOTICE, and a reader who wants to verify that can get to it in one click from
 * the footer and from the same spot on the homepage. What leaves the front page is
 * the *emphasis*: a licence obligation is not a reason to subscribe, and a page whose
 * last line is a company name is a page that has stopped selling.
 *
 * ## `head` is a function here
 *
 * The first version passed an object literal and the type rejected it: this router
 * version types `head` as a loader, and every other legal page uses
 * `buildPageSeo({ …, path })`. Matching the sibling pages is the point — **a page
 * that invents its own SEO shape is a page whose metadata can drift.**
 */
export const Route = createFileRoute("/_marketing/notices")({
  head: () =>
    buildPageSeo({
      title: "Notices",
      description:
        "OpenGeo's licence, copyright and upstream attribution. OpenGeo is MIT-licensed and derives from OpenSEO.",
      path: "/notices",
      titleSuffix: "OpenGeo",
    }),
  component: NoticesPage,
});

function NoticesPage() {
  return (
    <LegalPage
      title="Notices"
      description="Licence, copyright and upstream attribution for OpenGeo."
    >
      <h2 id="licence">Licence</h2>
      <p>
        OpenGeo is released under the MIT License. The full text is in{" "}
        <a
          href="https://github.com/RatioArtificiosa/Open-GEO/blob/main/LICENSE"
          target="_blank"
          rel="noopener noreferrer"
        >
          LICENSE
        </a>{" "}
        in the repository, and applies to the whole platform — the web
        application, the scheduler, the database migrations and the DataForSEO
        integration.
      </p>
      <p>
        The commercial hosted service at{" "}
        <a href="https://app.opengeo.so">app.opengeo.so</a> is operated by Every
        App, Inc. The MIT licence covers the source code; the terms covering the
        hosted service are in{" "}
        <a href="/terms-and-conditions">Terms and Conditions</a>.
      </p>

      <h2 id="copyright">Copyright</h2>
      <p>
        Copyright © 2026 Ben Senescu. All rights reserved for the original
        OpenSEO work, preserved intact.
      </p>

      <h2 id="upstream">Upstream attribution</h2>
      <p>
        OpenGeo is a derivative work of{" "}
        <a
          href="https://github.com/every-app/open-seo"
          target="_blank"
          rel="noopener noreferrer"
        >
          OpenSEO
        </a>
        , used under the MIT License. We are grateful to the original authors.
      </p>
      <p>
        The NOTICE file travelling with the source carries the same statement:{" "}
        <a
          href="https://github.com/RatioArtificiosa/Open-GEO/blob/main/NOTICE.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          NOTICE.md
        </a>
        .
      </p>

      <h2 id="data">Data and third parties</h2>
      <p>
        Search, keyword and AI-answer data is retrieved through DataForSEO.
        DataForSEO is an independent supplier and is not affiliated with
        OpenGeo. The rate card we are billed is published in the repository, and
        every figure on the pricing page is derived from it:{" "}
        <a
          href="https://github.com/RatioArtificiosa/Open-GEO/blob/main/src/shared/dataforseo-pricing.ts"
          target="_blank"
          rel="noopener noreferrer"
        >
          src/shared/dataforseo-pricing.ts
        </a>
        .
      </p>
      <p>
        Google Search Console data is read through Google's own API under
        Google's terms. Google and ChatGPT are trademarks of their respective
        owners, used here only to name the platforms we measure.
      </p>
    </LegalPage>
  );
}
