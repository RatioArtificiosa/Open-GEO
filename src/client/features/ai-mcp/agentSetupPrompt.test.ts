import { describe, expect, it } from "vitest";
import { getAgentSetupPrompt } from "./agentSetupPrompt";

describe("agent setup prompt", () => {
  it("copies the installer body without its internal skill metadata", () => {
    const prompt = getAgentSetupPrompt("https://app.opengeo.so");
    expect(prompt).toContain("Identify this agent and its version");
    expect(prompt).not.toContain("I use Codex");
    expect(prompt).not.toContain("internal: true");
    expect(prompt).toContain("https://opengeo.so/docs/codex-plugin");
    expect(prompt).toContain("https://opengeo.so/docs/skills/setup");
    expect(prompt).toContain("whoami and list_projects");
  });
  it("uses the current instance for MCP and API keys while keeping public docs links", () => {
    const prompt = getAgentSetupPrompt("https://seo.example.com");
    expect(prompt).toContain("https://seo.example.com/mcp");
    expect(prompt).toContain("https://seo.example.com/settings");
    expect(prompt).not.toContain("https://app.opengeo.so");
    expect(prompt).toContain("https://opengeo.so/docs/mcp");
    expect(prompt).not.toContain("I use Other agent");
  });
});
