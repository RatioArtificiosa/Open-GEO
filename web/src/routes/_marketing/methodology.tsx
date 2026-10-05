import { createFileRoute } from "@tanstack/react-router";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { DocsBody } from "fumadocs-ui/page";
import MethodologyContent, {
  frontmatter as methodologyFrontmatter,
} from "../../../content/marketing/methodology.md";
import { buildPageSeo } from "@/lib/seo";

/**
 * `/methodology` — the page the hero's "See the evidence" link points at.
 *
 * ## Why this page had to exist before the hero could
 *
 * The hero's whole argument is a number with its provenance one click away. **The
 * provenance page did not exist.** `docs/METHODOLOGY.md` ships in the repo and
 * `OPENGEO_PROPOSAL.md` §13.1 lists `/methodology`, but no route was ever built — so
 * a hero built on that link would have shipped a 404 on its central claim.
 *
 * **A claim without a destination is a boast.** The number was always true and
 * verifiable; what was missing was the page that lets a reader check it.
 *
 * ## Why "what we do not claim" is the first section
 *
 * It is the most persuasive thing here for the buyer this product has. A
 * competitor catalogue says what it does; a page leading with what it refuses to do
 * makes a different claim — that its other numbers can be trusted. `competitors.md`
 * finding 2: **nobody in the category leads with proof**, and this is where that
 * ground is available.
 */
export const Route = createFileRoute("/_marketing/methodology")({
  head: () =>
    buildPageSeo({
      title: methodologyFrontmatter.title,
      description: methodologyFrontmatter.description,
      path: "/methodology",
      titleSuffix: "OpenGeo",
    }),
  component: Methodology,
});

function Methodology() {
  return (
    <article className="mx-auto max-w-3xl text-neutral-900">
      <header className="mb-10 border-b border-[var(--color-border-subtle)] pb-8">
        <h1 className="text-4xl font-semibold leading-tight tracking-tight text-neutral-950 md:text-6xl">
          {methodologyFrontmatter.title}
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-[var(--color-brand-muted)]">
          {methodologyFrontmatter.description}
        </p>
      </header>

      <DocsBody className="min-w-0 text-neutral-800 [&_a]:!text-neutral-950 [&_a]:font-medium [&_a]:underline [&_a]:decoration-[var(--color-brand-accent-text)] [&_a]:underline-offset-4 [&_h2]:!text-neutral-950 [&_h2_a]:!no-underline [&_li]:!text-neutral-700 [&_p]:!text-neutral-700 [&_table]:!text-sm">
        <MethodologyContent components={defaultMdxComponents} />
      </DocsBody>
    </article>
  );
}
