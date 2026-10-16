import { describe, expect, it } from "vitest";
import { resolveSetupModal } from "./setupModalDecision";

/**
 * CL-106's modal contract, pinned without a DOM.
 *
 * The defect: the effect wrote `setShow(!configured)` on every run, so a
 * dismissal survived exactly until the next refetch or navigation. The fix
 * records dismissal in session state and only ever opens. Each case below is
 * one arm of that contract; removing any arm reopens the defect it names.
 */
describe("resolveSetupModal", () => {
  it("opens once for a missing key the user has not dismissed", () => {
    expect(
      resolveSetupModal({
        shouldCheck: true,
        isError: false,
        isSuccess: true,
        configured: false,
        dismissed: false,
      }),
    ).toBe(true);
  });

  it("leaves a dismissal alone on refetch, the exact CL-106 defect", () => {
    // Success re-runs the effect with fresh data; dismissed stays dismissed.
    expect(
      resolveSetupModal({
        shouldCheck: true,
        isError: false,
        isSuccess: true,
        configured: false,
        dismissed: true,
      }),
    ).toBeNull();
  });

  it("leaves a configured key alone rather than closing unseen UI", () => {
    expect(
      resolveSetupModal({
        shouldCheck: true,
        isError: false,
        isSuccess: true,
        configured: true,
        dismissed: false,
      }),
    ).toBeNull();
  });

  it("leaves a pending query alone: no data is not evidence", () => {
    expect(
      resolveSetupModal({
        shouldCheck: true,
        isError: false,
        isSuccess: false,
        configured: null,
        dismissed: false,
      }),
    ).toBeNull();
  });

  it("closes on error and on unchecked routes", () => {
    expect(
      resolveSetupModal({
        shouldCheck: true,
        isError: true,
        isSuccess: false,
        configured: null,
        dismissed: false,
      }),
    ).toBe(false);
    expect(
      resolveSetupModal({
        shouldCheck: false,
        isError: false,
        isSuccess: false,
        configured: null,
        dismissed: false,
      }),
    ).toBe(false);
  });
});
