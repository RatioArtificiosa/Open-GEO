import { describe, expect, it } from "vitest";
import { hostOf, normaliseUrlForJoin, stripWww } from "./urlIdentity";

/**
 * URL identity for the inclusion–citation join.
 *
 * The failure this prevents is the expensive one: the gap query joins citations
 * to retrievals on exact string equality, so every spelling difference
 * manufactures a phantom "retrieved but never cited" — the product's headline
 * finding, asserted about a page that was in fact cited.
 *
 * The direction of the errors matters too. Collapsing two genuinely different
 * pages hides a real gap; leaving one page spelled two ways invents one. Both
 * are bad, and the tests pin which is accepted where.
 */

describe("normaliseUrlForJoin", () => {
  it("treats a trailing slash as the same page", () => {
    // The cheapest possible false gap, and a real one: most CMSs serve both.
    expect(normaliseUrlForJoin("https://acme.com/pricing")).toBe(
      normaliseUrlForJoin("https://acme.com/pricing/"),
    );
  });

  it("strips the tracking parameters ChatGPT actually appends", () => {
    // `?utm_source=openai` is in the *documented* payloads, so this is the
    // common case rather than the rare one.
    expect(
      normaliseUrlForJoin("https://acme.com/pricing?utm_source=openai"),
    ).toBe(normaliseUrlForJoin("https://acme.com/pricing"));
    expect(normaliseUrlForJoin("https://acme.com/p?id=42&gclid=abc")).toBe(
      normaliseUrlForJoin("https://acme.com/p?id=42"),
    );
  });

  it("keeps query parameters that identify a different page", () => {
    // `?page=2` is not the same page as page 1. Collapsing them would merge a
    // real gap with a real citation — the opposite error, and just as wrong.
    expect(normaliseUrlForJoin("https://acme.com/p?page=2")).not.toBe(
      normaliseUrlForJoin("https://acme.com/p?page=1"),
    );
  });

  it("ignores query parameter order", () => {
    // One page, two spellings. Sorting is what stops a re-ordered query string
    // from creating a second identity.
    expect(normaliseUrlForJoin("https://acme.com/p?b=2&a=1")).toBe(
      normaliseUrlForJoin("https://acme.com/p?a=1&b=2"),
    );
  });

  it("ignores scheme, www, case and the default port", () => {
    const canonical = normaliseUrlForJoin("https://acme.com/pricing");
    for (const variant of [
      "http://acme.com/pricing",
      "https://www.acme.com/pricing",
      "HTTPS://ACME.COM/pricing",
      "https://acme.com:443/pricing",
      "http://acme.com:80/pricing",
    ]) {
      expect(normaliseUrlForJoin(variant)).toBe(canonical);
    }
  });

  it("keeps a non-default port, because that is a different service", () => {
    expect(normaliseUrlForJoin("https://acme.com:8443/x")).not.toBe(
      normaliseUrlForJoin("https://acme.com/x"),
    );
  });

  it("drops the fragment, which is client-side only", () => {
    expect(normaliseUrlForJoin("https://acme.com/p#section-2")).toBe(
      normaliseUrlForJoin("https://acme.com/p"),
    );
  });

  it("keeps the path, so two pages on one domain stay two pages", () => {
    expect(normaliseUrlForJoin("https://acme.com/pricing")).not.toBe(
      normaliseUrlForJoin("https://acme.com/about"),
    );
  });

  it("returns null rather than an empty key for unusable input", () => {
    // An empty key would match every other empty key and manufacture a gap out
    // of two rows we could not read.
    expect(normaliseUrlForJoin(null)).toBeNull();
    expect(normaliseUrlForJoin(undefined)).toBeNull();
    expect(normaliseUrlForJoin("   ")).toBeNull();
    expect(normaliseUrlForJoin("https://")).toBeNull();
  });

  it("handles a bare host with no scheme", () => {
    expect(normaliseUrlForJoin("acme.com/pricing")).toBe(
      normaliseUrlForJoin("https://acme.com/pricing"),
    );
  });

  it("keeps a root path equal to no path", () => {
    expect(normaliseUrlForJoin("https://acme.com/")).toBe(
      normaliseUrlForJoin("https://acme.com"),
    );
  });

  it("does not fold a path case difference", () => {
    // Hosts are case-insensitive; paths are not. Folding the path would merge
    // two pages that a server may well treat as distinct.
    expect(normaliseUrlForJoin("https://acme.com/Pricing")).not.toBe(
      normaliseUrlForJoin("https://acme.com/pricing"),
    );
  });
});

describe("hostOf", () => {
  it("returns the host for an ownership check, without the www prefix", () => {
    // Same normalisation as the join key, so a caller filtering "is this one of
    // ours?" cannot disagree with the join about what counts as the same site.
    expect(hostOf("https://www.acme.com/pricing?utm_source=x")).toBe(
      "acme.com",
    );
  });

  it("is null for unusable input", () => {
    expect(hostOf(null)).toBeNull();
    expect(hostOf("")).toBeNull();
  });
});

describe("stripWww", () => {
  it("removes a leading www so a domain filter matches both forms", () => {
    expect(stripWww("www.acme.com")).toBe("acme.com");
    expect(stripWww("acme.com")).toBe("acme.com");
  });
});
