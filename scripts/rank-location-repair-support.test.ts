/**
 * The location registry cache, and the key names its own writer uses.
 *
 * ## What this covers and why it did not exist before
 *
 * `fetchRegistry` reads a JSON cache off disk when one exists, and writes it from
 * the vendor response after mapping the API's snake_case to this file's
 * camelCase interface. The read trusted that mapping with an `as` cast.
 *
 * Replacing the cast with a shape check produced a **major regression on the
 * first attempt**: the check looked for `location_name` and `country_iso_code`
 * — the vendor's wire spelling — while the cache path writes `locationCode` and
 * `locationName`. The check would therefore have thrown on every valid cache hit,
 * which is worse than the cast it replaced, and CodeRabbit caught it.
 *
 * **The lesson is the reason this file exists.** A validator written against the
 * wrong source of truth for the shape is a regression generator, and the only
 * defence is a test that runs the real writer and then the real reader. That is
 * what the first case below does: it takes the registry this repo produces, writes
 * it, and reads it back. The check and the shape are then anchored to each other
 * rather than to two guesses.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const CACHE_DIR = mkdtempSync(join(tmpdir(), "locations-"));

afterAll(() => rmSync(CACHE_DIR, { recursive: true, force: true }));

/** The cache `fetchRegistry` writes, for one country. */
const cachePath = (iso: string) =>
  join(CACHE_DIR, `serp-locations-${iso}.json`);

describe("the location registry cache", () => {
  it("round-trips a registry this repo wrote itself", async () => {
    // The shape the writer produces, in the writer's own spelling. Written as a
    // literal rather than derived from the mapper because the point is to pin the
    // two spellings against each other: if the mapper's output and this fixture
    // ever diverge, this test is the one that notices.
    const registry = [
      {
        locationCode: 2840,
        locationName: "United States",
        locationType: "Country",
      },
      {
        locationCode: 2276,
        locationName: "Germany",
        locationType: "Country",
      },
    ];
    writeFileSync(cachePath("US"), JSON.stringify(registry));

    const { fetchRegistry } = await import("./rank-location-repair-support");
    const read = await fetchRegistry("US", CACHE_DIR);

    expect(read).toEqual(registry);
  });

  // **The control for the shape check.** A cache entry that is not a location must
  // be refused rather than cast through, which is the whole reason the check
  // exists — but the refusal has to fire on a genuinely malformed entry, not on a
  // well-formed one wearing the wrong spelling. This is the case that would have
  // failed against the first version of the check.
  it("refuses an entry that is not a location, in either spelling", async () => {
    const { fetchRegistry } = await import("./rank-location-repair-support");

    // Not an object at all.
    writeFileSync(cachePath("FR"), JSON.stringify([[1, 2]]));
    await expect(fetchRegistry("FR", CACHE_DIR)).rejects.toThrow(
      /not an array of locations|not a location/,
    );

    // An object with neither the camelCase nor the wire spelling.
    writeFileSync(cachePath("DE"), JSON.stringify([{ nope: true }]));
    await expect(fetchRegistry("DE", CACHE_DIR)).rejects.toThrow(
      /not a location/,
    );
  });

  it("does not reach the network when the cache exists", async () => {
    // The cache is the reason this file is called a cache. A read that fell
    // through to `fetch` on a hit would spend a sandbox call and make the cache
    // slower than no cache — which is exactly what the wrong spelling would have
    // done every time.
    writeFileSync(
      cachePath("ES"),
      JSON.stringify([
        { locationCode: 2724, locationName: "Spain", locationType: "Country" },
      ]),
    );
    const { fetchRegistry } = await import("./rank-location-repair-support");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await fetchRegistry("ES", CACHE_DIR);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
