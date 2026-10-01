import { GeoSetupRepository } from "@/server/features/geo/repositories/GeoSetupRepository";
import { runBatch } from "@/db/runBatch";
import { AppError } from "@/server/lib/errors";

/**
 * Prompt sets: the questions a queued GEO run asks.
 *
 * ## Why this is its own module
 *
 * `GeoService.ts` is the GEO facade and it was already at the `max-lines` ceiling
 * before these functions existed. They are a **coherent unit with their own
 * subject** — a project configuring what it asks — rather than part of the archive
 * or the sharing surface, and a facade that grows past its limit is the rule
 * correctly reporting that it has acquired a second subject.
 *
 * `GeoService` re-exports all four, so every call site is unchanged. That is
 * deliberate: a barrel that stops re-exporting is a breaking change for every
 * caller, and the win here is file size, not a new import path to remember.
 *
 * ## The one that made the queued path reachable
 *
 * `promptsForQueuedRun` is the reason any of this is called from a scheduler.
 * `GeoPatrol`'s queued branch refused to post without an explicit prompt list, and
 * nothing in production supplied one — so the whole path was built, tested and
 * dormant. Reading the project's saved questions is the entire fix.
 */

/** Every set for a project, each with its prompts. */
async function listPromptSets(projectId: string) {
  const sets = await GeoSetupRepository.listPromptSets(projectId);
  return Promise.all(
    sets.map(async (set) => ({
      ...set,
      prompts: await GeoSetupRepository.listPrompts(projectId, set.id),
    })),
  );
}

/**
 * The prompts a queued run would ask, or `[]` when the project has none.
 *
 * ## Which set, and why it is not "the latest"
 *
 * A project can hold several prompt sets (`geo_prompt_sets` has no uniqueness
 * beyond project+name). Picking the newest by `created_at` would be a silent
 * choice with a real consequence: a project that saved "competitor comparison" in
 * March and "brand terms" in June would have its March set chosen, and a run would
 * post questions the owner retired. Picking "the first" has the same defect in the
 * other direction.
 *
 * So the rule is **every prompt in every set, in set order then position order** —
 * a queued run asks what the project has actually configured, and the answer is
 * visible in the run log as a count. `position` is preserved because a curated
 * order is information: it is the order the owner built, and the vendor is not told
 * the difference, but the archive records which answer belongs to which question.
 *
 * Duplicates are dropped, and the count is logged by the caller, because asking
 * the same question twice in one run costs money and returns a second copy of an
 * answer we already have.
 */
async function promptsForQueuedRun(projectId: string): Promise<string[]> {
  const sets = await GeoSetupRepository.listPromptSets(projectId);
  if (sets.length === 0) return [];
  const ordered = await Promise.all(
    sets.map((set) => GeoSetupRepository.listPrompts(projectId, set.id)),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  // `listPrompts` returns whole `geo_prompts` rows, so the question itself is
  // the `prompt` field and the rest of the row — intent, position, the set it
  // belongs to — is not read here. That is deliberate: the run asks questions, and
  // the intent is a classification the recommender caches for its own use.
  for (const row of ordered.flat()) {
    const trimmed = row.prompt.trim();
    // A blank prompt is not a question. `createPromptSet` requires at least one
    // entry but does not require it to have text, so an empty one reaches here and
    // would be posted as a question with no words in it.
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Create a prompt set and its prompts in one atomic batch. */
async function createPromptSet(input: {
  projectId: string;
  name: string;
  description?: string;
  prompts: Array<{ prompt: string; intent?: string | null }>;
}) {
  if (input.prompts.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "A prompt set needs at least one prompt. Add prompts before saving.",
    );
  }
  const setId = crypto.randomUUID();
  await runBatch((tx) => [
    GeoSetupRepository.insertPromptSet(tx, {
      id: setId,
      projectId: input.projectId,
      name: input.name.trim(),
      description: input.description ?? null,
    }),
    ...GeoSetupRepository.insertPrompts(tx, setId, input.prompts),
  ]);
  const set = await GeoSetupRepository.getPromptSet(input.projectId, setId);
  if (!set) {
    // Carries the same wording as `GeoService`'s own not-found, which names the
    // call that would list what exists. Copied rather than imported because the
    // helper is module-private there, and a shared "not found" sentence is not
    // worth a new module of its own.
    throw new AppError(
      "NOT_FOUND",
      `No prompt set ${setId} in this project. Call listPromptSets to see what exists.`,
    );
  }
  return set;
}

/** Delete a prompt set. Its prompts cascade. */
async function deletePromptSet(projectId: string, promptSetId: string) {
  await runBatch((tx) => [
    GeoSetupRepository.deletePromptSet(tx, projectId, promptSetId),
  ]);
  return (
    (await GeoSetupRepository.getPromptSet(projectId, promptSetId)) === null
  );
}

export {
  createPromptSet,
  deletePromptSet,
  listPromptSets,
  promptsForQueuedRun,
};
