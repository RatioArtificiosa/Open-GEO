import { type ReactNode, useEffect, useRef, useState } from "react";

/** Give wide result tables a visible scroll hint and keyboard access. */
export function ToolTable({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const update = () =>
      setScrollable(container.scrollWidth > container.clientWidth + 1);
    const observer = new ResizeObserver(update);
    observer.observe(container);
    if (container.firstElementChild)
      observer.observe(container.firstElementChild);
    update();
    return () => observer.disconnect();
  }, []);

  return (
    <div className={`min-w-0 ${className ?? ""}`}>
      {scrollable ? (
        <p className="mb-2 text-xs text-[var(--color-brand-muted)]">
          Scroll sideways to see all columns.
        </p>
      ) : null}
      <div
        ref={ref}
        role="region"
        aria-label={label}
        tabIndex={scrollable ? 0 : undefined}
        className="overflow-x-auto rounded-lg border border-[var(--color-border-subtle)] bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
      >
        {children}
      </div>
    </div>
  );
}
