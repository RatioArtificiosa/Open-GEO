/**
 * The path normaliser, tested against the three defects it exists to prevent.
 *
 * **Every case here is a bug that shipped**, which is why they are written as the *failure*
 * rather than as the happy path: a test that only proves `relative()` works would pass on the
 * machine that caused all three.
 */
import { describe, expect, it } from "vitest";

import {
  isUnder,
  namesVendorImage,
  PATH_SEPARATOR,
  repoRelative,
} from "@/server/lib/repoPaths";

const ROOT = process.cwd();

describe("repoRelative", () => {
  it("returns forward slashes whatever the platform produces", () => {
    const out = repoRelative("src/client/components/Button.tsx", ROOT);
    // **The assertion is about the absence of a backslash**, because that is the entire
    // defect: every one of the three failures was a comparison against "src/…/" over a
    // backslashed path.
    expect(out).toBe("src/client/components/Button.tsx");
    expect(out.includes("\\")).toBe(false);
    // **And the reason a comparison against a literal can fail at all.** On this machine the
    // platform separator is a backslash, so an un-normalised path can never contain a forward
    // slash — which is the whole reason `PATH_SEPARATOR` is exported rather than inlined in a
    // comment: `knip` caught it sitting unused, and the honest fix was to assert on it.
    expect(out.includes(PATH_SEPARATOR)).toBe(PATH_SEPARATOR === "/");
  });

  it("normalises an absolute Windows path, which is the shape a walk() yields", () => {
    // **The shape that actually broke.** `walk` returns absolute paths, and on Windows an
    // absolute path contains no forward slash — so `includes("src/client/")` was false for
    // every file and the gate reported clean.
    const absolute = `${ROOT}\\src\\client\\components\\Button.tsx`;
    expect(repoRelative(absolute, ROOT)).toBe(
      "src/client/components/Button.tsx",
    );
  });

  it("makes a forward-slash filter match, which is the point of the whole module", () => {
    const absolute = `${ROOT}\\src\\client\\Leak.tsx`;
    const label = repoRelative(absolute, ROOT);
    expect(label.includes("src/client/")).toBe(true);
  });
});

describe("isUnder", () => {
  it("matches a path inside the prefix", () => {
    expect(
      isUnder(`${ROOT}\\vendor-assets\\a.bin`, "vendor-assets", ROOT),
    ).toBe(true);
  });

  it("does NOT match a sibling whose name merely starts with the prefix", () => {
    // **The erasure case.** A plain `startsWith` says `vendor-assets` is inside
    // `vendor-assets-manifest`, so a GDPR sweep deletes a bucket nobody asked it to. This is
    // the one assertion in the file that is about *not* deleting.
    expect(isUnder("vendor-assets-manifest/a.bin", "vendor-assets", ROOT)).toBe(
      false,
    );
    expect(isUnder("vendor-assetsX/a.bin", "vendor-assets", ROOT)).toBe(false);
  });

  it("matches the prefix itself", () => {
    expect(isUnder("vendor-assets", "vendor-assets", ROOT)).toBe(true);
  });
});

describe("namesVendorImage", () => {
  it("is true only when a vendor host and an image key co-occur", () => {
    const hosts = ["api.dataforseo.com"];
    // **Both halves are required**, and that is the design: a module that merely names the
    // vendor may be pricing a screenshot or linking a doc page, and flagging it would make the
    // gate something people switch off.
    expect(
      namesVendorImage(
        'const p = { url: "https://api.dataforseo.com/x/final-screenshot.jpg" };',
        hosts,
      ),
    ).toBe(true);
    // A host alone is not a leak.
    expect(
      namesVendorImage(
        'export const DOCS = "https://api.dataforseo.com/docs";',
        hosts,
      ),
    ).toBe(false);
    // An image key on our own CDN is not a leak either.
    expect(
      namesVendorImage(
        '<img src="https://cdn.example.com/final-screenshot.png" />',
        hosts,
      ),
    ).toBe(false);
  });

  it("reports a boolean, because a boolean is the shape the gates can assert on", () => {
    // **`gates-about-gates` accepts only `.toBe(true)` / `.toBe(false)` as evidence of a
    // finding**, so a predicate returning "a match or undefined" cannot be counted as a
    // control by any gate that reads it.
    expect(
      namesVendorImage("api.dataforseo.com final-screenshot", [
        "api.dataforseo.com",
      ]),
    ).toBe(true);
    expect(namesVendorImage("example.com", ["api.dataforseo.com"])).toBe(false);
  });
});
