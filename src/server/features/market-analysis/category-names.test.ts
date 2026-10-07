/**
 * The join, and the case that made it worth writing down.
 *
 * The taxonomy is seeded from a dated vendor file, so a fresh response can name a criterion that
 * file predates. The dangerous implementation is the convenient one: `filter(Boolean)` on the
 * resolved names, which produces a tidy profile that is quietly missing a category. These tests
 * pin the opposite — an unnamed category stays, with `name: null`, so a reader can see that our
 * taxonomy is behind rather than believing the profile is complete.
 */
import { describe, expect, it } from "vitest";
import { attachCategoryNames, collectCriterionIds } from "./category-names";

const names = new Map<number, string>([
  [10007, "/Computers/Software"],
  [13418, "/Business/Printing, Copying & Mailing"],
]);

describe("attachCategoryNames", () => {
  it("names the categories it knows", () => {
    const [item] = attachCategoryNames([{ categories: [10007] }], names);
    expect(item?.categoryNames).toEqual([
      { criterionId: 10007, name: "/Computers/Software" },
    ]);
  });

  it("keeps an unnameable category with a null name rather than dropping it", () => {
    // A criterion newer than the committed CSV. Dropping it would understate the profile with
    // nothing on screen to explain the gap, which is the failure this asserts against.
    const [item] = attachCategoryNames([{ categories: [10007, 99999] }], names);
    expect(item?.categoryNames).toEqual([
      { criterionId: 10007, name: "/Computers/Software" },
      { criterionId: 99999, name: null },
    ]);
  });

  it("keeps the vendor's order when an item carries several categories", () => {
    const [item] = attachCategoryNames([{ categories: [13418, 10007] }], names);
    expect(item?.categoryNames.map((category) => category.criterionId)).toEqual(
      [13418, 10007],
    );
  });

  it("returns an empty list for an item with no categories, not null", () => {
    // `[]` is "the vendor named none", which is different from the `null` an unnamed lookup
    // produces one level down. Collapsing them would make an empty profile indistinguishable
    // from a failed join.
    const [item] = attachCategoryNames([{ categories: null }], names);
    expect(item?.categoryNames).toEqual([]);
  });
});

describe("collectCriterionIds", () => {
  it("gathers every id so the lookup is one query", () => {
    expect(
      collectCriterionIds([
        { categories: [10007, 13418] },
        { categories: [10007] },
        { categories: null },
      ]),
    ).toEqual([10007, 13418, 10007]);
  });
});
