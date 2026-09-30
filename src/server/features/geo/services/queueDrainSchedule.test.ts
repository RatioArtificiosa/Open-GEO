import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAIN_INTERVAL_MS,
  isDrainDue,
  VENDOR_CEILING_MS,
} from "./queueDrainSchedule";

/**
 * The drain's cadence and its reporting.
 *
 * The cadence tests are the load-bearing ones. Everything about *when* this runs
 * follows from one vendor number — a Standard task may take **72 hours** — and a
 * cadence that is not derived from that number is a guess, and a guess here means
 * either sampling a backlog or expiring work before the drain ever looked at it.
 */
const NOW = new Date("2026-10-01T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  vi.useRealTimers();
});

describe("isDrainDue", () => {
  it("looks immediately when there is no record of a previous look", () => {
    // Null means "we have never looked", and that is the definition of due.
    expect(isDrainDue(null, NOW)).toBe(true);
  });

  it("waits between looks", () => {
    expect(isDrainDue(new Date(NOW.getTime() - HOUR).toISOString(), NOW)).toBe(
      false,
    );
  });

  it("looks again once the interval has passed", () => {
    expect(
      isDrainDue(
        new Date(NOW.getTime() - DRAIN_INTERVAL_MS).toISOString(),
        NOW,
      ),
    ).toBe(true);
  });

  it("looks when the recorded time is unreadable, rather than never", () => {
    // A clock we cannot read must never be the reason we stop collecting. The
    // alternative — treating it as "not due" — is a silent permanent stall.
    expect(isDrainDue("not-a-date", NOW)).toBe(true);
  });

  it("is a third of the vendor's 72-hour ceiling", () => {
    // Not a tidiness choice. A cadence coarser than a third of the ceiling means
    // an unlucky task gets **one** look and then times out, which is the exact
    // failure the ceiling exists to make visible.
    //
    // The ceiling is imported rather than written out, so a change to the
    // documented number **fails this test** instead of silently making the
    // cadence wrong.
    expect(DRAIN_INTERVAL_MS * 3).toBeLessThanOrEqual(VENDOR_CEILING_MS);
    // ...and not so coarse that it is most of the ceiling.
    expect(DRAIN_INTERVAL_MS * 3).toBeGreaterThan(VENDOR_CEILING_MS * 0.5);
  });
});
