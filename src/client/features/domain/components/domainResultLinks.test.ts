import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import { describe, expect, it, vi } from "vitest";
import { DomainPagesTable } from "./DomainPagesTable";
import { DomainKeywordsTable } from "./DomainKeywordsTable";

const tableProps = {
  domain: "zumvu.com",
  sortMode: "traffic" as const,
  currentSortOrder: "desc" as const,
  onSortClick: vi.fn(),
};

describe("domain result links", () => {
  it.each([
    "https://blog.zumvu.com/pounds-to-ounces/",
    "http://blog.zumvu.com/pounds-to-ounces/?unit=oz#calculator",
    "https://zumvu.com/pounds-to-ounces/",
  ])("links Top Pages to the original URL: %s", (page) => {
    const $ = load(
      renderToStaticMarkup(
        createElement(DomainPagesTable, {
          ...tableProps,
          rows: [
            {
              page,
              relativePath: "/pounds-to-ounces/",
              organicTraffic: 100,
              keywords: 10,
            },
          ],
        }),
      ),
    );

    expect($("tbody a").attr("href")).toBe(page);
    expect($("tbody a").text()).toBe("/pounds-to-ounces/");
  });

  it.each([
    [
      "https://blog.zumvu.com/pounds-to-ounces/",
      "https://blog.zumvu.com/pounds-to-ounces/",
    ],
    [null, "https://zumvu.com/pounds-to-ounces/"],
    ["", "https://zumvu.com/pounds-to-ounces/"],
  ])("links Top Keywords with URL %s", (url, expectedHref) => {
    const $ = load(
      renderToStaticMarkup(
        createElement(DomainKeywordsTable, {
          ...tableProps,
          selectedKeywords: new Set<string>(),
          visibleKeywords: ["pounds to ounces"],
          onToggleKeyword: vi.fn(),
          rows: [
            {
              keyword: "pounds to ounces",
              position: 1,
              searchVolume: 100,
              traffic: 10,
              cpc: null,
              url,
              relativeUrl: "/pounds-to-ounces/",
              keywordDifficulty: null,
            },
          ],
        }),
      ),
    );

    expect($("tbody a").attr("href")).toBe(expectedHref);
    expect($("tbody a").text()).toBe("/pounds-to-ounces/");
  });
});
