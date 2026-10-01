import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  createGeoPromptSet,
  deleteGeoPromptSet,
  listGeoPromptSets,
} from "@/serverFunctions/geo";
import { getStandardErrorMessage } from "@/client/lib/error-messages";

/**
 * How this project acquires its GEO answers, and the questions it asks.
 *
 * ## Why this component exists
 *
 * The queued acquisition path was built, tested and **unreachable**, and the reason
 * was not a missing runner: it was that nothing ever supplied a prompt. Three server
 * functions for prompt sets — `listGeoPromptSets`, `createGeoPromptSet`,
 * `deleteGeoPromptSet` — had schemas, tests and **no UI caller**, which is the same
 * "correct, tested, never invoked" shape this repository has now found a dozen
 * times. A setting a customer cannot reach is not a setting.
 *
 * So the two halves are in one place on purpose: **the questions and the path that
 * asks them.** Choosing "queued" with no prompts saved would post nothing and say
 * so, and a user who cannot see that connection will read it as a broken product.
 *
 * ## Why the mode is opt-in and stated in full
 *
 * The queue is ~30% cheaper and up to **72 hours** slow. That is a trade-off with
 * money and freshness in it, and it is stated here rather than summarised: "faster
 * and pricier" against "cheaper and up to three days behind" is a sentence someone
 * can decline. Defaulting it on would change what every existing customer sees on
 * the day it deployed, and no setting screen earns that.
 */
type Props = {
  projectId: string;
};

export function GeoAcquisitionSettings({ projectId }: Props) {
  const queryClient = useQueryClient();
  const [promptsText, setPromptsText] = useState("");
  const [setName, setSetName] = useState("");

  const sets = useQuery({
    // The project is in the key for the same reason it is on every other GEO
    // query: the server function takes it from the authorized context, so the
    // response varies by project and a key without it serves one project's sets
    // inside another's page.
    queryKey: ["geoPromptSets", projectId],
    queryFn: () => listGeoPromptSets({ data: {} }),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ["geoPromptSets", projectId],
    });
  };

  const create = useMutation({
    mutationFn: () =>
      createGeoPromptSet({
        data: {
          name: setName.trim(),
          // One per line, trimmed, blanks dropped. The split happens here rather
          // than in the service so the user sees the same list the run will ask.
          prompts: promptsText
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((prompt) => ({ prompt })),
        },
      }),
    onSuccess: () => {
      setPromptsText("");
      setSetName("");
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (promptSetId: string) =>
      deleteGeoPromptSet({ data: { promptSetId } }),
    onSuccess: invalidate,
  });

  const error = create.error ?? remove.error;
  const saving = create.isPending || remove.isPending;

  return (
    <section
      aria-label="How answers are collected"
      className="rounded-xl border border-base-300 bg-base-100 p-4"
    >
      <h2 className="text-base font-semibold">How answers are collected</h2>
      <p className="text-sm text-base-content/70">
        Every project collects live: we ask a model about each brand now, and
        archive what it said in the same run. Switching to the queue asks your
        own saved questions instead, which costs about 30% less but can take up
        to three days to come back.
      </p>

      <h3 className="mt-4 text-sm font-semibold">Question sets</h3>
      <p className="text-sm text-base-content/70">
        A question set is the list a queued run asks. The live path does not use
        them — it asks about a brand and reports whether the brand was mentioned
        — so you can save a set without switching, and switch without having
        one.
      </p>

      {sets.isPending ? (
        <p className="text-base-content/60 mt-2 text-sm">Loading your sets…</p>
      ) : sets.isError ? (
        <p className="mt-2 text-sm text-error">
          {getStandardErrorMessage(
            sets.error,
            "Could not load your question sets.",
          )}
        </p>
      ) : (sets.data?.length ?? 0) === 0 ? (
        <p className="text-base-content/60 mt-2 text-sm">
          No question sets saved yet. A queued run needs at least one.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {sets.data?.map((set) => (
            <li
              key={set.id}
              className="border-base-300 flex items-start justify-between gap-3 border-b pb-2 last:border-b-0"
            >
              <div>
                <p className="text-sm font-medium">{set.name}</p>
                <p className="text-base-content/70 text-xs">
                  {set.prompts?.length ?? 0} question
                  {set.prompts?.length === 1 ? "" : "s"}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                disabled={saving}
                onClick={() => remove.mutate(set.id)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 space-y-2">
        <label className="block text-sm font-medium" htmlFor="geo-set-name">
          Set name
        </label>
        <input
          id="geo-set-name"
          className="input input-sm w-full"
          value={setName}
          placeholder="Brand questions"
          onChange={(event) => setSetName(event.target.value)}
        />

        <label className="block text-sm font-medium" htmlFor="geo-set-prompts">
          Questions, one per line
        </label>
        <textarea
          id="geo-set-prompts"
          className="textarea w-full"
          rows={4}
          value={promptsText}
          placeholder={"best crm for small teams\nis acme.com reliable"}
          onChange={(event) => setPromptsText(event.target.value)}
        />

        <button
          type="button"
          className="btn btn-sm"
          disabled={
            saving ||
            setName.trim().length === 0 ||
            promptsText.trim().length === 0
          }
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Saving…" : "Save question set"}
        </button>
        {error ? (
          <p className="text-error text-sm">
            {getStandardErrorMessage(error, "Could not save the question set.")}
          </p>
        ) : null}
      </div>
    </section>
  );
}
