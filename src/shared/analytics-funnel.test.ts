/**
 * The signup recorder, and the property that matters most about it.
 *
 * ## The event firing is the smaller half
 *
 * That the stage records the right name is worth an assertion, and it is a
 * one-liner. What is worth a file is the other half: **an analytics failure must
 * never take down a signup.** The recorder runs in
 * `databaseHooks.user.create.after`, so the user row already exists — throwing out
 * of here would mean a signup that created an account and then returned an error,
 * which is a user who cannot log in with an account they own.
 */
import { describe, expect, it, vi } from "vitest";
import { recordFunnelSignup } from "./analytics-funnel";

describe("recordFunnelSignup", () => {
  it("records the signup stage with the email-verified fact", async () => {
    const capture = vi.fn(async () => {});
    await recordFunnelSignup({ id: "u1", emailVerified: true }, capture);
    expect(capture).toHaveBeenCalledWith("signup", { email_verified: true });
  });

  it("records an unverified email as false, not as absent", async () => {
    // An absent property reads as "unknown" to a funnel and a false reads as
    // "known and false". They are different questions and only one of them is the
    // truth here.
    const capture = vi.fn(async () => {});
    await recordFunnelSignup({ id: "u1" }, capture);
    expect(capture).toHaveBeenCalledWith("signup", { email_verified: false });
  });

  // **The property that justifies the extraction.** The user row exists when this
  // runs, so a throw that escapes is a signup that made an account and then
  // failed — the worst kind of auth bug, because the account is real and
  // unreachable.
  it("does not fail a signup when the capture throws", async () => {
    const capture = vi.fn(async () => {
      throw new Error("PostHog unreachable");
    });
    await expect(
      recordFunnelSignup({ id: "u1", emailVerified: true }, capture),
    ).resolves.toBeUndefined();
  });

  it("does not log the capture failure on the signup path", async () => {
    // A log line per user created while PostHog is down is a different outage with
    // the same cause. The failure is silent because the signup is the thing that
    // matters, and a silent metrics gap is recoverable while a loud log flood is a
    // second incident.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await recordFunnelSignup({ id: "u1" }, async () => {
      throw new Error("PostHog unreachable");
    });
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
