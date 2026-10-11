import type { FormEvent } from "react";
import { Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getBrandLookupCostEstimate } from "@/serverFunctions/billing";
import { ResearchScopeSelect } from "@/client/components/ResearchScopeSelect";
import type { ResearchScope } from "@/shared/researchScope";
import { BRAND_LOOKUP_MAX_INPUT_LENGTH } from "@/types/schemas/ai-search";

type Props = {
  query: string;
  onQueryChange: (next: string) => void;
  scope: ResearchScope;
  onScopeChange: (next: ResearchScope) => void;
  scopeDisabledReason: string | undefined;
  competitors: string;
  onCompetitorsChange: (next: string) => void;
  onSubmit: (event: FormEvent) => void;
  isLoading: boolean;
  validationError: { field: "query" | "competitors"; message: string } | null;
};

export function BrandLookupSearchCard({
  query,
  onQueryChange,
  scope,
  onScopeChange,
  scopeDisabledReason,
  competitors,
  onCompetitorsChange,
  onSubmit,
  isLoading,
  validationError,
}: Props) {
  // The displayed price is the customer's price, resolved on the server at the
  // live multiplier. A self-hoster sees the raw vendor rate, because for them
  // that is the whole cost — the multiplier defaults to no markup at all.
  const { data: cost } = useQuery({
    queryKey: ["brandLookupCostEstimate"],
    queryFn: () => getBrandLookupCostEstimate(),
  });
  const hasCompetitors = competitors.trim().length > 0;
  const queryError = validationError?.field === "query";
  const competitorsError = validationError?.field === "competitors";

  return (
    <div className="card border border-base-300 bg-base-100">
      <div className="card-body gap-4">
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <label
              className={`input input-bordered flex flex-1 items-center gap-2 ${
                queryError ? "input-error" : ""
              }`}
            >
              <Search className="size-4 text-base-content/60" />
              <input
                type="text"
                placeholder="Enter a brand name or domain"
                value={query}
                maxLength={BRAND_LOOKUP_MAX_INPUT_LENGTH}
                onChange={(event) => onQueryChange(event.target.value)}
                aria-invalid={queryError || undefined}
                aria-describedby={
                  queryError ? "brand-lookup-input-error" : undefined
                }
                autoComplete="off"
                spellCheck={false}
                className="grow"
              />
            </label>

            <ResearchScopeSelect
              value={scope}
              onChange={onScopeChange}
              disabledReason={scopeDisabledReason}
            />

            <button
              type="submit"
              className="btn btn-primary shrink-0 px-6"
              disabled={isLoading}
            >
              {isLoading ? "Looking up..." : "Look up"}
            </button>
          </div>

          <div className="flex flex-col gap-1">
            <input
              type="text"
              placeholder="Add competitors (comma-separated)"
              value={competitors}
              onChange={(event) => onCompetitorsChange(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className={`input input-bordered w-full ${
                competitorsError ? "input-error" : ""
              }`}
              aria-label="Competitors"
              aria-invalid={competitorsError || undefined}
              aria-describedby={
                competitorsError ? "brand-lookup-input-error" : undefined
              }
            />
            <p className="text-xs text-base-content/60">
              Add up to 5 competitor brands or domains to see your Share of
              Voice.
            </p>
          </div>
        </form>

        {validationError ? (
          <p id="brand-lookup-input-error" className="text-sm text-error">
            {validationError.message}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 text-xs text-base-content/60">
          <p className="tabular-nums">
            Est.{" "}
            <span className="font-medium text-base-content/80">
              ${cost ? cost.baseUsd.toFixed(2) : "…"}
            </span>
            {hasCompetitors ? (
              <span>
                {" "}
                plus ~$
                {cost ? cost.competitorUsd.toFixed(2) : "…"} to compare
                competitors
              </span>
            ) : null}
          </p>
        </div>
      </div>
    </div>
  );
}
