import { describe, expect, it } from "vitest";
import { buildBrandFraming, type BrandEntityBucket } from "./brandFraming";

/**
 * "How AI Frames Your Brand".
 *
 * The panel's job is a positioning diagnosis — "AI thinks you're a Formula One
 * team, not a car manufacturer" — and the interesting cases are the ones where
 * there is *no* diagnosis to give. An entity with no label of its own is a
 * stronger finding than a wrong one, so the null path has to be as loud as the
 * populated one.
 */

const bucket = (
  key: BrandEntityBucket["key"],
  mentions: number | null,
  aiSearchVolume: number | null = null,
): BrandEntityBucket => ({ key, mentions, aiSearchVolume });

describe("buildBrandFraming", () => {
  it("says this is ChatGPT's view and not every AI engine's", () => {
    // DataForSEO returns brand entities for ChatGPT only. A panel that said "AI
    // thinks you're a Formula One team" with no platform would be read as a
    // statement about AI in general, which is the whole reason to name it.
    const framing = buildBrandFraming({
      domain: "acme.com",
      title: [bucket("Acme Cars", 40)],
      category: null,
    });
    expect(framing.platform).toBe("chat_gpt");
    expect(framing.caveat).toMatch(/ChatGPT's view only/i);
    expect(framing.caveat).toMatch(/not for Google/i);
  });

  it("names the gap between the brand's own label and the dominant one", () => {
    const framing = buildBrandFraming({
      domain: "acme.com",
      title: [bucket("Acme Cars", 40)],
      category: [bucket("Formula One Team", 900)],
    });
    expect(framing.diagnosis).toMatch(/files acme.com as "Acme Cars"/i);
    expect(framing.diagnosis).toMatch(/Formula One Team/i);
    expect(framing.diagnosis).toMatch(/positioning problem/i);
  });

  it("reports a consistent positioning plainly", () => {
    const framing = buildBrandFraming({
      domain: "acme.com",
      title: [bucket("Acme Cars", 900)],
      category: [bucket("Car Manufacturer", 500)],
    });
    expect(framing.diagnosis).toMatch(/positioning is consistent/i);
  });

  it("treats an unlabelled entity as the finding, not as missing data", () => {
    // The most valuable output of this panel: ChatGPT has mentions for the
    // domain but never files it under a label of its own. A null `ownBucket`
    // rendered as an empty state would throw away the diagnosis.
    const framing = buildBrandFraming({
      domain: "acme.com",
      title: [bucket("Formula One Team", 900)],
      category: [bucket("Car Manufacturer", 400)],
    });
    expect(framing.ownBucket).toBeNull();
    expect(framing.diagnosis).toMatch(/never appears as a bucket of its own/i);
    expect(framing.diagnosis).toMatch(/cannot place/i);
  });

  it("distinguishes no buckets at all from an unplaced entity", () => {
    // "No data" and "we could not read a label" are different findings, and the
    // first must not be phrased as the second.
    const framing = buildBrandFraming({
      domain: "acme.com",
      title: null,
      category: null,
    });
    expect(framing.diagnosis).toMatch(/no brand-entity buckets/i);
    expect(framing.diagnosis).toMatch(/not evidence that ChatGPT has no view/i);
    expect(framing.totalMentions).toBeNull();
  });

  it("matches a bare label against a domain", () => {
    // Providers return bucket keys inconsistently: sometimes "Acme Cars",
    // sometimes "acme.com". A strict comparison would report "not filed" for a
    // brand that plainly was, and that is a misdiagnosis of positioning.
    const framing = buildBrandFraming({
      domain: "www.acme.com",
      title: [bucket("Acme", 50)],
      category: null,
    });
    expect(framing.ownBucket?.key).toBe("Acme");
    expect(framing.diagnosis).toMatch(/files/i);
  });

  it("sorts buckets by mentions with unknown counts last", () => {
    const framing = buildBrandFraming({
      domain: "acme.com",
      title: [
        bucket("Acme Cars", 10),
        bucket("Unknown Bucket", null),
        bucket("Rival", 90),
      ],
      category: null,
    });
    expect(framing.titleBuckets.map((b) => b.key)).toEqual([
      "Rival",
      "Acme Cars",
      "Unknown Bucket",
    ]);
  });

  it("sums mentions across buckets, which is the one total it offers", () => {
    // Buckets on one platform are the same event counted over disjoint
    // categories, so summing them is legitimate in a way summing platforms is
    // not. The absence of any demand total is asserted below.
    const framing = buildBrandFraming({
      domain: "acme.com",
      title: [bucket("A", 10, 5000), bucket("B", 5, 2000)],
      category: [bucket("C", 1, 100)],
    });
    expect(framing.totalMentions).toBe(16);
    // The bucket figures are carried, never totalled into a "demand" number.
    for (const key of Object.keys(framing)) {
      expect(key.toLowerCase()).not.toMatch(/^total.*volume$/);
    }
  });

  it("does not report a zero total when no bucket had a count", () => {
    const framing = buildBrandFraming({
      domain: "acme.com",
      title: [bucket("A", null), bucket("B", null)],
      category: null,
    });
    expect(framing.totalMentions).toBeNull();
  });

  it("reads a numeric bucket key without mangling it", () => {
    // The provider types `key` as string | number, so a bare `String()` on a
    // number is the only handling needed — but it must not become "undefined".
    const framing = buildBrandFraming({
      domain: "acme.com",
      title: [bucket(2840, 12)],
      category: null,
    });
    expect(framing.titleBuckets[0]?.key).toBe(2840);
  });
});
