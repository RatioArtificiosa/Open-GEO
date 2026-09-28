import * as Popover from "@radix-ui/react-popover";

export function formatCount(value: number | null | undefined): string {
  return typeof value === "number"
    ? Math.round(value).toLocaleString("en-US")
    : "—";
}

export function formatMoney(value: number | null | undefined): string {
  if (typeof value !== "number") return "—";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** Tap or click for details; the portal keeps help outside clipped cards. */
export function InfoTip({
  tip,
  align = "center",
}: {
  tip: string;
  align?: "center" | "right";
}) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={tip}
          className="ml-0.5 inline-flex h-7 w-7 items-center justify-center rounded-full align-middle text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            className="h-3.5 w-3.5"
          >
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" />
            <path
              d="M8 7.25v3.25M8 5.25v.1"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label="More information"
          sideOffset={6}
          collisionPadding={12}
          align={align === "right" ? "end" : "center"}
          className="z-[60] w-64 max-w-[calc(100vw-24px)] rounded-lg bg-neutral-950 px-4 py-3 text-left text-sm font-normal leading-6 text-white shadow-lg"
        >
          {tip}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

type Metric = {
  label: string;
  value: string;
  tip?: string;
};

/** Stack on narrow phones, then use two or four columns as space allows. */
export function MetricGrid({ metrics }: { metrics: Metric[] }) {
  return (
    <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-border-subtle)] min-[360px]:grid-cols-2 md:grid-cols-4">
      {metrics.map((metric) => (
        <div
          key={metric.label}
          className="min-w-0 bg-white p-4 [overflow-wrap:anywhere] md:p-5"
        >
          <dt className="text-xs text-[var(--color-brand-muted)]">
            {metric.label}
            {metric.tip ? <InfoTip tip={metric.tip} /> : null}
          </dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums text-neutral-950 sm:text-xl">
            {metric.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
