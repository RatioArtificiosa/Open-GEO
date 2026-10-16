/**
 * Brief-to-draft regeneration without silent overwrites (CL-725 loop core).
 *
 * A draft is regions with provenance: each carries whether a human touched
 * it since the last generation. Regeneration merges by region id, and the
 * rule is absolute — **a human-edited region whose regenerated text differs
 * is a conflict, kept and reported, never overwritten.** Convenience that
 * discards an editor's work is data loss wearing a feature name, and the
 * report names what was kept so the choice stays visible.
 */

export type DraftRegion = {
  /** Stable across regenerations of one brief; the join key. */
  id: string;
  text: string;
  /** True once a human edits the region after generation. */
  humanEdited: boolean;
};

type DraftConflict = {
  id: string;
  /** The human text that was kept. */
  kept: string;
  /** The regenerated text that was not applied. */
  discarded: string;
  /** Why: the region changed under a human edit, or vanished from the regen. */
  reason: "edited" | "removed";
};

export type DraftMerge = {
  merged: DraftRegion[];
  conflicts: DraftConflict[];
};

/**
 * Merge a regeneration into the current draft. Pure: the caller persists.
 *
 * Fresh regions (never edited) take the regenerated text. New ids append in
 * regen order. Edited regions that changed — or that the regen dropped —
 * stay human with a conflict entry. An edited region the regen reproduced
 * byte-for-byte keeps its flag: the edit stands even where it agrees.
 */
export function mergeDraftWithRegeneration(
  current: DraftRegion[],
  regenerated: DraftRegion[],
): DraftMerge {
  const regenById = new Map(regenerated.map((region) => [region.id, region]));
  const merged: DraftRegion[] = [];
  const conflicts: DraftConflict[] = [];
  const seen = new Set<string>();

  for (const region of current) {
    seen.add(region.id);
    const next = regenById.get(region.id);
    if (next === undefined) {
      if (region.humanEdited) {
        conflicts.push({
          id: region.id,
          kept: region.text,
          discarded: "",
          reason: "removed",
        });
      }
      merged.push(region);
      continue;
    }
    if (region.humanEdited && next.text !== region.text) {
      conflicts.push({
        id: region.id,
        kept: region.text,
        discarded: next.text,
        reason: "edited",
      });
      merged.push(region);
      continue;
    }
    merged.push({ ...next, humanEdited: region.humanEdited });
  }

  for (const region of regenerated) {
    if (!seen.has(region.id)) {
      merged.push({ ...region, humanEdited: false });
    }
  }

  return { merged, conflicts };
}
