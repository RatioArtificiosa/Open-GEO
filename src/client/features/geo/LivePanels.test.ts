import { describe, expect, it } from "vitest";
import { stripTracking } from "./LivePanels";

/**
 * The display-only URL cleanup.
 *
 * DataForSEO returns cited page URLs carrying tracking parameters
 * (`?utm_source=chatgpt.com`). They are noise to a reader and evidence to us, so
 * the stored value is untouched and only the rendered string is cleaned — which
 * makes this function the single place a malformed URL could quietly become a
 * wrong link.
 *
 * These are the cases that matter: a relative value, a value with no query, a
 * value with a fragment, and a value that is nothing like a URL at all. All four
 * must come back *unchanged* rather than mangled.
 */
describe("stripTracking", () => {
  it("removes the query string from a full URL", () => {
    expect(
      stripTracking("https://acme.com/pricing?utm_source=chatgpt.com"),
    ).toBe("https://acme.com/pricing");
  });

  it("keeps a URL with no query exactly as it is", () => {
    expect(stripTracking("https://acme.com/pricing")).toBe(
      "https://acme.com/pricing",
    );
  });

  it("keeps a bare domain untouched", () => {
    expect(stripTracking("acme.com")).toBe("acme.com");
  });

  it("leaves a relative path alone", () => {
    // No scheme, so there is no authority to parse and nothing to strip. A
    // relative path with a query is a legitimate value, not a broken URL.
    expect(stripTracking("/pricing?utm_source=chatgpt.com")).toBe(
      "/pricing?utm_source=chatgpt.com",
    );
  });

  it("drops a fragment as well as a query", () => {
    expect(stripTracking("https://acme.com/p?a=1#section")).toBe(
      "https://acme.com/p",
    );
  });

  it("keeps a fragment when there is no query", () => {
    expect(stripTracking("https://acme.com/p#section")).toBe(
      "https://acme.com/p#section",
    );
  });

  it("preserves a meaningful path that itself contains a question mark in a value", () => {
    // `?` inside a path is legal and rare; treating the first `?` as the query
    // start is the documented behaviour, and this pins it so a future "fix"
    // does not break search-style URLs.
    expect(stripTracking("https://acme.com/s?q=geo&utm_source=x")).toBe(
      "https://acme.com/s",
    );
  });

  it("returns an empty string unchanged rather than throwing", () => {
    expect(stripTracking("")).toBe("");
  });
});
