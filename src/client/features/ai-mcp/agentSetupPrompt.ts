// **`setup-opengeo`, lowercase, exactly as the directory is named.**
//
// This read `setup-OpenGeo`, and on a case-insensitive filesystem (macOS,
// Windows) that resolves fine — which is why it survived. CI runs on Linux, where
// the import 404s, and `scripts/prepublish-audit.test.ts` is the gate that catches
// it: *"import casing matches the filesystem, because CI is Linux"*.
//
// It surfaced while splitting the skills between the two repos: the tracked path
// changed from the stale `setup-OpenGeo` history carried to `setup-opengeo`, and
// the import stopped matching. **A rename is the change that makes a latent
// case-sensitivity bug visible.**
import installerSkill from "../../../../.agents/skills/setup-opengeo/SKILL.md?raw";
import updatePrompt from "./agentUpdatePrompt.md?raw";

export const agentUpdatePrompt = updatePrompt.trim();

// The copyable installer and internal skill share one source of truth.
export function getAgentSetupPrompt(origin: string) {
  const instructions = installerSkill
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .trim();
  return instructions.replaceAll("https://app.opengeo.so", origin);
}
