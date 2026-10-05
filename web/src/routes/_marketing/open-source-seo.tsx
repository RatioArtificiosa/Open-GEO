import { createFileRoute } from "@tanstack/react-router";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { DocsBody } from "fumadocs-ui/page";
import OpenSourceSeoContent, {
  frontmatter as openSourceSeoFrontmatter,
} from "../../../content/marketing/open-source-seo.md";
import { buildPageSeo } from "@/lib/seo";

export const Route = createFileRoute("/_marketing/open-source-seo")({
  head: () =>
    buildPageSeo({
      title: openSourceSeoFrontmatter.title,
      description: openSourceSeoFrontmatter.description,
      path: "/open-source-seo",
      titleSuffix: "OpenGeo",
      ogType: "article",
    }),
  component: OpenSourceSeoPage,
});

function OpenSourceSeoPage() {
  return (
    <article className="mx-auto max-w-4xl text-neutral-900">
      <header className="mb-10 border-b border-[var(--color-border-subtle)] pb-8">
        <p className="text-sm font-medium text-[var(--color-brand-accent-text)]">
          Open Source SEO
        </p>
        <h1 className="mt-3 text-4xl font-semibold leading-tight tracking-tight text-neutral-950 md:text-6xl">
          {openSourceSeoFrontmatter.title}
        </h1>
        {openSourceSeoFrontmatter.description ? (
          <p className="mt-5 max-w-2xl text-lg leading-8 text-[var(--color-brand-muted)]">
            {openSourceSeoFrontmatter.description}
          </p>
        ) : null}
      </header>

      <DocsBody className="min-w-0 text-neutral-800 [&_a]:!text-neutral-950 [&_h2]:!text-neutral-950 [&_h2_a]:!no-underline [&_h3]:!text-neutral-950 [&_h3_a]:!no-underline [&_h4]:!text-neutral-950 [&_h4_a]:!no-underline [&_h5_a]:!no-underline [&_h6_a]:!no-underline [&_li]:!text-neutral-700 [&_li_a]:font-medium [&_li_a]:underline [&_li_a]:decoration-[var(--color-brand-accent)] [&_li_a]:underline-offset-4 [&_li_a:hover]:!text-neutral-700 [&_p]:!text-neutral-700 [&_p_a]:font-medium [&_p_a]:underline [&_p_a]:decoration-[var(--color-brand-accent)] [&_p_a]:underline-offset-4 [&_p_a:hover]:!text-neutral-700 [&_strong]:!text-neutral-950">
        <OpenSourceSeoContent components={defaultMdxComponents} />
      </DocsBody>

      <OpenSourceSeoCta />
    </article>
  );
}

/**
 * The close.
 *
 * **It asked for a star.** "Try the hosted app… Or, check it out on GitHub. **Make
 * sure to give it a star!**" — two equal-weight buttons, asking for a GitHub action at
 * the exact moment the reader has concluded the product is free and open source.
 * **That converts the sale into a bookmark.**
 *
 * Now the hosted app is the only button, and the page's own strongest claim leads:
 * read the code first, *then* run it here.
 */
function OpenSourceSeoCta() {
  return (
    <section className="mt-14 rounded-xl border border-[var(--color-border-subtle)] bg-white p-6">
      <p className="text-xl font-semibold tracking-tight text-neutral-950">
        Read the code, then run it here
      </p>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-brand-muted)]">
        Everything on this page is checkable in the repository, and it is worth
        checking before you subscribe. When you would rather not run a database
        and a scheduler, that is what the $10 plan is for: $10 of usage included
        each month, and a free account with $0.50 of credit so you can check it
        works first.
      </p>
      <div className="mt-5 flex flex-col gap-3 sm:flex-row">
        <a
          href="https://app.opengeo.so/sign-up"
          className="inline-flex h-10 items-center justify-center rounded-lg bg-neutral-950 px-4 text-sm font-medium text-white transition-colors hover:bg-neutral-800"
        >
          Start free
          <span className="ml-2" aria-hidden="true">
            &rarr;
          </span>
        </a>
        {/* **A text link, not a second button.** The repository is one click away in
            the footer and the page already linked it twice; a button here would put
            a GitHub action at the same weight as the one we actually want. */}
        <a
          href="/docs/self-hosting"
          className="inline-flex h-10 items-center justify-center rounded-lg px-1 text-sm font-medium text-[var(--color-brand-muted)] underline underline-offset-4 transition-colors hover:text-neutral-950"
        >
          Or read how self-hosting works
        </a>
      </div>
    </section>
  );
}
