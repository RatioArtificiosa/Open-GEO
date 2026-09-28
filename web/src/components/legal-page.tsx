import { DocsBody } from "fumadocs-ui/page";
import type { ReactNode } from "react";

type LegalPageProps = {
  title: string;
  description?: string;
  children: ReactNode;
};

export function LegalPage({ title, description, children }: LegalPageProps) {
  return (
    <article className="mx-auto w-full min-w-0 max-w-3xl text-neutral-950">
      <header className="mb-10 border-b border-[var(--color-border-subtle)] pb-8">
        <h1 className="mb-4 text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
          {title}
        </h1>
        {description ? (
          <p className="text-lg leading-8 text-[var(--color-brand-muted)]">
            {description}
          </p>
        ) : null}
      </header>

      <DocsBody className="min-w-0 break-words text-neutral-800 [&_a]:!text-neutral-950 [&_a]:underline [&_a]:decoration-[var(--color-brand-accent)] [&_a]:underline-offset-4 [&_h2]:text-neutral-950 [&_h3]:text-neutral-950 [&_li]:text-neutral-700 [&_p]:text-neutral-700 [&_strong]:text-neutral-950">
        {children}
      </DocsBody>
    </article>
  );
}
