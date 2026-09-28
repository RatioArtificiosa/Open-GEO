import { describe, expect, it, vi } from "vitest";
import {
  buildOnboardingPayload,
  restoreOnboardingAnswers,
} from "./onboardingModel";

vi.mock("@/serverFunctions/onboarding", () => ({
  getOnboardingAnswers: vi.fn(),
}));
const saved = {
  interestedFeatures: ["Keyword research"],
  workFor: "My own startup or business",
  clientWebsiteCount: null,
  foundVia: "Google",
  mcpSetupIntent: null,
};

describe("historical onboarding values", () => {
  it("keeps a previously saved Google source recognized", () => {
    const answers = restoreOnboardingAnswers({ ...saved, foundVia: "Google" });
    expect(answers.source).toBe("Google");
    expect(answers.sourceOther).toBe("");
    expect(buildOnboardingPayload(answers, 4).foundVia).toBe("Google");
  });

  it.each(["My own startup or business", "My employer's website"])(
    "restores and saves the original work-for value: %s",
    (workFor) => {
      const answers = restoreOnboardingAnswers({ ...saved, workFor });
      expect(answers.workFor).toBe(workFor);
      expect(answers.workForOther).toBe("");
      expect(buildOnboardingPayload(answers, 4).workFor).toBe(workFor);
    },
  );

  it("keeps the original AI workflow value when restoring and saving", () => {
    const interestedFeatures = ["AI workflows with Claude or Codex (MCP)"];
    const answers = restoreOnboardingAnswers({ ...saved, interestedFeatures });
    expect(answers.selectedInterests).toEqual(interestedFeatures);
    expect(answers.interestOther).toBe("");
    expect(buildOnboardingPayload(answers, 4).interestedFeatures).toEqual(
      interestedFeatures,
    );
  });
});

describe("signup agent setup", () => {
  it("saves the optional agent choice on the final step only", () => {
    const answers = {
      ...restoreOnboardingAnswers(saved),
      mcpSetupIntent: "yes" as const,
    };
    expect(buildOnboardingPayload(answers, 3)).not.toHaveProperty(
      "mcpSetupIntent",
    );
    expect(
      buildOnboardingPayload(answers, 4, { completed: true }),
    ).toMatchObject({ mcpSetupIntent: "yes", completed: true });
  });
  it("lets users finish without an agent or without making a choice", () => {
    const answers = restoreOnboardingAnswers(saved);
    expect(
      buildOnboardingPayload(answers, 4, { completed: true }),
    ).toMatchObject({ completed: true });
    expect(
      buildOnboardingPayload({ ...answers, mcpSetupIntent: "no" }, 4, {
        completed: true,
      }),
    ).toMatchObject({ mcpSetupIntent: "no", completed: true });
  });
  it("saves No when finishing immediately, even before React updates the previous answer", () => {
    const answers = {
      ...restoreOnboardingAnswers(saved),
      mcpSetupIntent: "yes" as const,
    };
    expect(
      buildOnboardingPayload(answers, 4, {
        completed: true,
        mcpSetupIntent: "no",
      }),
    ).toMatchObject({ mcpSetupIntent: "no", completed: true });
  });
  it("restores a saved setup intent", () => {
    expect(
      restoreOnboardingAnswers({ ...saved, mcpSetupIntent: "yes" })
        .mcpSetupIntent,
    ).toBe("yes");
    expect(
      restoreOnboardingAnswers({ ...saved, mcpSetupIntent: "no" })
        .mcpSetupIntent,
    ).toBe("no");
  });
});
