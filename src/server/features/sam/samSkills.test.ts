import { describe, expect, it } from "vitest";
import { buildSamSkillSource } from "@/server/features/sam/samSkills";

describe("buildSamSkillSource", () => {
  // Guards the real failure modes: a skill whose frontmatter breaks (build
  // throws), an internal repo-dev skill leaking into SAM, or the public set
  // silently shrinking because a glob or marking change dropped it.
  it("serves exactly the public product skills", async () => {
    const source = buildSamSkillSource();
    const names = (await source.list()).map((skill) => skill.name);

    expect(names).toEqual([
      "competitive-landscape",
      "competitor-analysis",
      // GEO — the three skills that make this OpenGeo rather than OpenSEO.
      "geo-audit",
      "keyword-clustering",
      "keyword-research",
      "link-prospecting",
      "local-seo",
      "opengeo",
      "seo-audit",
      "seo-coach",
      "seo-project-setup",
      "what-to-build",
    ]);

    // **The gate's own comment says why this list is the point:** SAM serves
    // `.agents/skills/*/SKILL.md` to end users, so the directory is a *product*
    // surface, not a skills directory. When the repo-dev tooling (merge-ready,
    // papercuts, review-brief, deslop, …) was moved to the private repo, this
    // assertion failed — which is the correct behaviour, because the alternative
    // would have been silently shipping internal engineering instructions to
    // every customer's AI agent.
    //
    // **An exact list, not a count.** `toEqual` on the sorted names means a new
    // public skill is a decision someone has to make by editing this test, and a
    // new *internal* one cannot leak in unnoticed.

    const loaded = await source.load("seo-project-setup");
    expect(loaded?.body).toContain("Surface note: you are SAM");
  });
});
