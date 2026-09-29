import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  deleteGeoTarget,
  listGeoTargets,
  upsertGeoTarget,
} from "@/serverFunctions/geo";
import { useProjectMarket } from "@/client/features/projects/useProjectMarket";
import { getStandardErrorMessage } from "@/client/lib/error-messages";

/**
 * Add or remove a monitored brand.
 *
 * The market is **not free choice**. A GEO target's `locationCode` decides which
 * market the archive is measured in, and ChatGPT mention data is US/en only — so
 * a target saved with a mismatched market would accumulate data that silently
 * says nothing about the market the customer cares about. The project already
 * has a market; this form inherits it rather than asking, and says which one it
 * used.
 *
 * Deletion is a real promise: the target and its whole archive go. The confirm
 * names the domain so nobody removes the wrong one.
 */

type Props = {
  projectId: string;
  onChanged?: () => void;
};

export function GeoTargetForm({ projectId, onChanged }: Props) {
  const market = useProjectMarket(projectId);
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState("");
  const [name, setName] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const targets = useQuery({
    queryKey: ["geoTargets", projectId],
    queryFn: () => listGeoTargets({ data: {} }),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["geoTargets", projectId] });
    onChanged?.();
  };

  const add = useMutation({
    mutationFn: () =>
      upsertGeoTarget({
        data: {
          domain: domain.trim(),
          // A name is optional in the schema and defaults to the domain, which
          // is the right default: inventing a nicer name would put a word in the
          // user's mouth that they did not choose.
          name: name.trim() || undefined,
          locationCode: market?.locationCode ?? 2840,
          languageCode: market?.languageCode ?? "en",
        },
      }),
    onSuccess: () => {
      setDomain("");
      setName("");
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (targetId: string) => deleteGeoTarget({ data: { targetId } }),
    onSuccess: () => {
      setConfirmingId(null);
      invalidate();
    },
  });

  // The market must be loaded before saving, or a target would be written with
  // the fallback and quietly measure the wrong region.
  const marketReady = Boolean(market?.locationCode && market?.languageCode);
  const canSubmit = domain.trim().length > 0 && marketReady && !add.isPending;

  return (
    <section
      aria-label="Monitored brands"
      className="rounded-xl border border-base-300 bg-base-100 p-4"
    >
      <h2 className="text-base font-semibold">Monitored brands</h2>
      <p className="text-sm text-base-content/70">
        A brand is a domain plus a market. The archive is measured in that
        market only, and it fills from the nightly patrol.
      </p>

      {marketReady ? (
        <p className="text-base-content/60 mt-1 text-xs">
          Using this project&apos;s market ({market?.locationCode}/
          {market?.languageCode}).
        </p>
      ) : (
        <p className="text-base-content/60 mt-1 text-xs">
          Loading your project&apos;s market…
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {(targets.data ?? []).map((target) => (
          <li
            key={target.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-base-300 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{target.domain}</p>
              <p className="text-base-content/60 text-xs">
                {target.name} · {target.locationCode}/{target.languageCode}
              </p>
            </div>
            {confirmingId === target.id ? (
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-base-content/70 text-xs">
                  Delete {target.domain} and its archive?
                </span>
                <button
                  type="button"
                  className="btn btn-xs btn-error"
                  onClick={() => remove.mutate(target.id)}
                  disabled={remove.isPending}
                >
                  Yes, delete
                </button>
                <button
                  type="button"
                  className="btn btn-xs"
                  onClick={() => setConfirmingId(null)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-xs shrink-0"
                onClick={() => setConfirmingId(target.id)}
                aria-label={`Delete ${target.domain}`}
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </li>
        ))}
        {targets.data?.length === 0 ? (
          <li className="text-base-content/60 text-sm">
            Nothing monitored yet. Add a domain below.
          </li>
        ) : null}
      </ul>

      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) add.mutate();
        }}
      >
        <label className="form-control">
          <span className="label-text text-xs">Domain</span>
          <input
            type="text"
            className="input input-sm w-56"
            placeholder="acme.com"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
        </label>
        <label className="form-control">
          <span className="label-text text-xs">Name (optional)</span>
          <input
            type="text"
            className="input input-sm w-48"
            placeholder="Acme"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="btn btn-sm"
          disabled={!canSubmit}
          title={
            marketReady
              ? undefined
              : "Waiting for your project's market to load"
          }
        >
          <Plus className="size-4" />
          {add.isPending ? "Adding…" : "Add brand"}
        </button>
      </form>

      {add.error || remove.error || targets.error ? (
        <p className="text-error mt-2 text-sm">
          {getStandardErrorMessage(
            add.error ?? remove.error ?? targets.error,
            "Could not save that brand.",
          )}
        </p>
      ) : null}
    </section>
  );
}
