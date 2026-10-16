import { describe, expect, it } from "vitest";
import {
  type DraftMerge,
  type DraftRegion,
  mergeDraftWithRegeneration,
} from "./draftMerge";

/**
 * Regeneration never silently overwrites human edits (CL-725 loop rule).
 *
 * The merge is by region id with provenance on each region. Every case below
 * is a direction the rule must not confuse: fresh takes regen, edited keeps
 * human with a conflict, agreeing edits keep their flag, new ids append,
 * and a regen that drops an edited region reports the removal rather than
 * deleting work.
 */

const region = (
  id: string,
  text: string,
  humanEdited = false,
): DraftRegion => ({ id, text, humanEdited });

describe("mergeDraftWithRegeneration", () => {
  it("takes regenerated text for regions no human touched", () => {
    const outcome: DraftMerge = mergeDraftWithRegeneration(
      [region("intro", "old intro")],
      [region("intro", "new intro")],
    );
    expect(outcome.merged).toEqual([region("intro", "new intro")]);
    expect(outcome.conflicts).toEqual([]);
  });

  it("keeps human edits with a conflict naming both texts", () => {
    const { merged, conflicts } = mergeDraftWithRegeneration(
      [region("intro", "my intro", true)],
      [region("intro", "new intro")],
    );
    expect(merged).toEqual([region("intro", "my intro", true)]);
    expect(conflicts).toEqual([
      {
        id: "intro",
        kept: "my intro",
        discarded: "new intro",
        reason: "edited",
      },
    ]);
  });

  it("keeps the edited flag where human and regen agree", () => {
    const { merged, conflicts } = mergeDraftWithRegeneration(
      [region("intro", "same", true)],
      [region("intro", "same")],
    );
    expect(merged).toEqual([region("intro", "same", true)]);
    expect(conflicts).toEqual([]);
  });

  it("appends new regions and reports a regen that drops edited work", () => {
    const { merged, conflicts } = mergeDraftWithRegeneration(
      [region("intro", "my intro", true), region("outro", "my outro", true)],
      [region("intro", "my intro", true), region("faq", "new faq")],
    );
    expect(merged.map((row) => row.id)).toEqual(["intro", "outro", "faq"]);
    expect(merged.find((row) => row.id === "faq")).toMatchObject({
      text: "new faq",
      humanEdited: false,
    });
    // The dropped edited region stays, with the removal reported.
    expect(merged.find((row) => row.id === "outro")?.text).toBe("my outro");
    expect(conflicts).toEqual([
      { id: "outro", kept: "my outro", discarded: "", reason: "removed" },
    ]);
  });
});
