import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  getBillingAdminSettings,
  setCostMarkupSetting,
} from "@/serverFunctions/billing";

/**
 * The operator's billing dial, in one panel.
 *
 * ## What this is for
 *
 * The hosted markup used to be a constant in the source. That published the
 * platform's margin to anyone who opened the client bundle, which is the
 * behaviour the whole restructure removed. The value now lives here so the
 * owner can move it without a deploy, and so the first version of the admin
 * area has something real to administer.
 *
 * ## Why it shows where the value came from
 *
 * Three sources can supply the multiplier — this override, the
 * `BILLING_COST_MARKUP` binding, and "no markup at all". When an invoice
 * looks wrong, "which one is live" is the first question, and a panel that
 * shows a number without its source answers only the second one.
 */

const SOURCE_LABELS: Record<
  "operator" | "environment" | "default",
  { label: string; help: string }
> = {
  operator: {
    label: "Set here",
    help: "This value overrides the deployment's environment setting.",
  },
  environment: {
    label: "From the environment",
    help: "BILLING_COST_MARKUP is set on this deployment. Saving a value here overrides it.",
  },
  default: {
    label: "No markup",
    help: "Neither this panel nor the environment sets a markup, so vendor costs pass through unchanged.",
  },
};

export function BillingAdminSettings() {
  const queryClient = useQueryClient();
  const { data, isPending, error } = useQuery({
    queryKey: ["billingAdminSettings"],
    queryFn: () => getBillingAdminSettings(),
  });
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (data) setDraft(String(data.markup));
  }, [data]);

  const save = useMutation({
    mutationFn: (markup: number | null) =>
      setCostMarkupSetting({ data: { markup } }),
    onSuccess: async (result) => {
      queryClient.setQueryData(["billingAdminSettings"], result);
      setDraft(String(result.markup));
      toast.success(
        result.source === "operator"
          ? "Markup updated."
          : "Override cleared. The environment setting now applies.",
      );
    },
    onError: () => {
      toast.error("That value could not be saved.");
    },
  });

  if (isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-base-content/60">
        <Loader2 className="size-4 animate-spin" />
        Loading billing settings…
      </div>
    );
  }

  // 403 is the expected shape for everyone who is not the owner. A stranger
  // reaching this page sees the same thing they would see if it did not
  // exist, which leaks nothing about the deployment's configuration.
  if (error || !data) {
    return (
      <p className="text-sm text-base-content/50">
        This page is not available on your account.
      </p>
    );
  }

  const parsed = draft.trim() === "" ? null : Number(draft.trim());
  const isValid = parsed !== null && Number.isFinite(parsed) && parsed > 0;
  const source = SOURCE_LABELS[data.source];

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg bg-base-200/50 px-3 py-2.5 text-xs text-base-content/70">
        <Info className="size-3.5 shrink-0 mt-0.5" />
        <span>{source.help}</span>
      </div>

      <div className="form-control">
        <label className="label" htmlFor="markup">
          <span className="label-text font-medium">Cost markup</span>
          <span className="label-text-alt text-base-content/50">
            currently {source.label.toLowerCase()}: {data.markup}
          </span>
        </label>
        <div className="flex gap-2">
          <input
            id="markup"
            type="number"
            step="0.01"
            min="0.01"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="input input-bordered w-40 font-mono"
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={save.isPending || !isValid}
            onClick={() => isValid && save.mutate(parsed)}
          >
            {save.isPending && <Loader2 className="size-3 animate-spin" />}
            Save
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={save.isPending || data.source !== "operator"}
            onClick={() => save.mutate(null)}
            title="Hand control back to BILLING_COST_MARKUP"
          >
            <X className="size-3.5" />
            Clear override
          </button>
        </div>
      </div>

      {!isValid && draft.trim() !== "" && (
        <p className="text-xs text-error">
          Enter a number above zero. A zero or negative markup would make every
          hosted operation free, and a non-numeric one cannot be applied.
        </p>
      )}

      <p className="text-xs text-base-content/50">
        A value of 1.28 charges 28% above the vendor rate. Self-hosted
        deployments ignore this entirely: they pay the vendor directly and see
        the raw cost.
      </p>
    </div>
  );
}
