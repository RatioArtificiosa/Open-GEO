import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  assertOk,
  DataforseoChargedTaskError,
  parseTaskItems,
} from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";
import { getStandardErrorMessage } from "@/client/lib/error-messages";

const itemSchema = z.object({ keyword: z.string().optional() }).passthrough();

describe("parseTaskItems", () => {
  it("returns [] when the result items are null", () => {
    const task = { status_code: 20000, result: [{ items: null }] };
    expect(parseTaskItems("x", task, itemSchema)).toEqual([]);
  });

  it("returns [] when there is no result", () => {
    expect(parseTaskItems("x", { result: undefined }, itemSchema)).toEqual([]);
  });

  it("parses present items", () => {
    const task = { result: [{ items: [{ keyword: "seo" }] }] };
    expect(parseTaskItems("x", task, itemSchema)).toEqual([{ keyword: "seo" }]);
  });
});

describe("assertOk", () => {
  const okTask = {
    status_code: 20000,
    path: ["v3", "backlinks", "summary", "live"],
    cost: 0.1,
    result_count: 1,
    result: [],
  };

  it("returns the first task on success", () => {
    expect(assertOk({ status_code: 20000, tasks: [okTask] })).toBe(okTask);
  });

  it("throws DataforseoChargedTaskError when a charged task fails", () => {
    const task = {
      status_code: 40000,
      status_message: "fail",
      path: ["v3", "backlinks", "summary", "live"],
      cost: 0.05,
      result_count: 0,
    };
    try {
      assertOk({ status_code: 20000, tasks: [task] });
      throw new Error("expected assertOk to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DataforseoChargedTaskError);
      if (error instanceof DataforseoChargedTaskError) {
        expect(error.billing).toEqual({
          path: task.path,
          costUsd: 0.05,
        });
      }
    }
  });

  it("classifies DataForSEO's own server errors as UPSTREAM_UNAVAILABLE", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const task = {
      status_code: 40101,
      status_message: "Internal SE Server Error.",
      path: ["v3", "serp", "google", "organic", "live", "advanced"],
      cost: 0.002,
      result_count: 0,
    };
    try {
      assertOk({ status_code: 20000, tasks: [task] });
      throw new Error("expected assertOk to throw");
    } catch (error) {
      // Still a charged-task error so the billed attempt stays metered.
      expect(error).toBeInstanceOf(DataforseoChargedTaskError);
      if (error instanceof DataforseoChargedTaskError) {
        expect(error.code).toBe("UPSTREAM_UNAVAILABLE");
      }
    }
  });

  /**
   * `50304` is the one code in the failure set that is **not** a provider flake.
   *
   * It answers for a family the account holds no entitlement to — the ten hidden
   * families all answer it today, every time, forever. Folding it into
   * `UPSTREAM_UNAVAILABLE` tells a reader to retry in a moment for something that
   * will not work in any moment, which is the shape this repository already paid
   * for once: a route answering "temporarily unavailable" that surfaces as
   * **broken** rather than **disabled** costs an afternoon, because the symptom is
   * identical to a provider outage and the cause is an entitlement nobody granted.
   */
  describe("50304 is a feature that is switched off, not a provider flake", () => {
    it("classifies as UPSTREAM_FEATURE_DISABLED, not UPSTREAM_UNAVAILABLE", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const task = {
        status_code: 50304,
        status_message: "This function temporarily unavailable.",
        path: ["v3", "content_generation", "generate_text", "live"],
        cost: 0.002,
        result_count: 0,
      };
      try {
        assertOk({ status_code: 20000, tasks: [task] });
        throw new Error("expected assertOk to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(DataforseoChargedTaskError);
        if (error instanceof DataforseoChargedTaskError) {
          expect(error.code).toBe("UPSTREAM_FEATURE_DISABLED");
        }
      }
    });

    it("logs on its own line, so a rollout switching a family off is a count and not silence", () => {
      // The other failure codes warn under `upstream-task-failed`, where a
      // permanent entitlement decision would be filed as a provider outage and
      // buried in a rate. This is the assertion that keeps it visible.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const task = {
        status_code: 50304,
        status_message: "This function temporarily unavailable.",
        path: ["v3", "content_generation", "generate_text", "live"],
        cost: 0.002,
        result_count: 0,
      };
      try {
        assertOk({ status_code: 20000, tasks: [task] });
      } catch {}
      const calls = warn.mock.calls.map((call) => String(call[0]));
      expect(calls).toContain("dataforseo.feature-disabled");
      expect(calls).not.toContain("dataforseo.upstream-task-failed");
    });

    it("keeps a genuine provider flake on the unavailable path", () => {
      // The negative control: 50303 "Update in progress" is transient and must
      // still read as "retry in a moment". Without this, the disabled branch
      // could widen to the whole family and nothing would notice.
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const task = {
        status_code: 50303,
        status_message: "Update in progress. Please try after a few minutes.",
        path: ["v3", "serp", "google", "organic", "live", "advanced"],
        cost: 0.002,
        result_count: 0,
      };
      try {
        assertOk({ status_code: 20000, tasks: [task] });
        throw new Error("expected assertOk to throw");
      } catch (error) {
        if (error instanceof DataforseoChargedTaskError) {
          expect(error.code).toBe("UPSTREAM_UNAVAILABLE");
        }
      }
    });

    it("tells the reader it is switched off rather than failing", () => {
      // The copy is the product surface of this classification. "Retry in a
      // moment" on a permanent refusal is the sentence that costs the afternoon.
      expect(
        getStandardErrorMessage(new Error("UPSTREAM_FEATURE_DISABLED")),
      ).toContain("not enabled");
      expect(
        getStandardErrorMessage(new Error("UPSTREAM_FEATURE_DISABLED")),
      ).not.toContain("retry in a moment");
    });
  });

  it("keeps 'Not Implemented' reportable — we posted a bad task", () => {
    const task = {
      status_code: 50100,
      status_message: "Not Implemented.",
      path: ["v3", "serp", "google", "organic", "live", "advanced"],
      cost: 0.002,
      result_count: 0,
    };
    try {
      assertOk({ status_code: 20000, tasks: [task] });
      throw new Error("expected assertOk to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DataforseoChargedTaskError);
      if (error instanceof DataforseoChargedTaskError) {
        expect(error.code).toBe("INTERNAL_ERROR");
      }
    }
  });

  it("appends the echoed request value to opaque 'Invalid Field' failures", () => {
    const task = {
      status_code: 40501,
      status_message: "Invalid Field: 'target'.",
      path: ["v3", "dataforseo_labs", "google", "domain_rank_overview", "live"],
      cost: 0.02,
      result_count: 0,
      data: { target: "not a valid domain", language_code: "en" },
    };
    try {
      assertOk({ status_code: 20000, tasks: [task] });
      throw new Error("expected assertOk to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DataforseoChargedTaskError);
      if (error instanceof DataforseoChargedTaskError) {
        expect(error.message).toBe(
          `Invalid Field: 'target'. (sent target="not a valid domain")`,
        );
      }
    }
  });

  it("uses the classifier for non-charged (no-cost) failures", () => {
    const classify = vi.fn(
      () => new AppError("BACKLINKS_BILLING_ISSUE", "nope"),
    );
    const task = {
      status_code: 40200,
      status_message: "balance is too low",
    };
    expect(() =>
      assertOk(
        { status_code: 20000, tasks: [task] },
        { classify, classifyPath: "/v3/backlinks/summary/live" },
      ),
    ).toThrow("nope");
    expect(classify).toHaveBeenCalledWith(
      40200,
      "balance is too low",
      "/v3/backlinks/summary/live",
    );
  });

  it.each([
    [40200, "BACKLINKS_BILLING_ISSUE"],
    [40210, "BACKLINKS_BILLING_ISSUE"],
    [402, "BACKLINKS_BILLING_ISSUE"],
  ] as const)(
    "uses the classifier for account failure %s before charging billed task metadata",
    (status, code) => {
      const classify = vi.fn(
        () => new AppError(code, "Classified DataForSEO account failure"),
      );
      const task = {
        status_code: status,
        status_message: "Account balance is too low",
        path: ["v3", "backlinks", "summary", "live"],
        cost: 0.05,
        result_count: 0,
      };

      try {
        assertOk({ status_code: 20000, tasks: [task] }, { classify });
        throw new Error("expected assertOk to throw");
      } catch (error) {
        expect(error).not.toBeInstanceOf(DataforseoChargedTaskError);
        expect(error).toMatchObject({ code });
      }
      expect(classify).toHaveBeenCalledWith(
        status,
        "Account balance is too low",
        "/v3/backlinks/summary/live",
      );
    },
  );

  it("treats 40501 as an empty success when asked", () => {
    const task = {
      status_code: 40501,
      status_message: "No Search Results",
      path: ["v3", "serp", "google", "organic", "live", "advanced"],
      cost: 0.0,
    };
    expect(
      assertOk(
        { status_code: 20000, tasks: [task] },
        { treatNoResultsAsEmpty: true },
      ),
    ).toBe(task);
  });

  it("still surfaces a charged 40501 'Invalid Field' failure even with treatNoResultsAsEmpty", () => {
    // 40501 is not unique to no-results — it also covers validation rejections,
    // which are real charged failures we must not mask as empty results.
    const task = {
      status_code: 40501,
      status_message: "Invalid Field: 'categories'.",
      path: ["v3", "business_data", "business_listings", "search", "live"],
      cost: 0.02,
      result_count: 0,
      data: { categories: ["not_a_real_category"] },
    };
    try {
      assertOk(
        { status_code: 20000, tasks: [task] },
        { treatNoResultsAsEmpty: true },
      );
      throw new Error("expected assertOk to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DataforseoChargedTaskError);
      if (error instanceof DataforseoChargedTaskError) {
        expect(error.billing).toEqual({ path: task.path, costUsd: 0.02 });
      }
    }
  });
});
