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

    const loaded = await source.load("seo-project-setup");
    expect(loaded?.body).toContain("Surface note: you are SAM");
  });
});
