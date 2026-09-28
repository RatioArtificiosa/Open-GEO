// How a page fetch resolved. "blocked" = WAF/bot challenge stood in the way;
// "rate_limited" = a 429 prevented the crawler from reading the page.
// Declared once so the SQLite and Postgres columns, the MCP filter, and the
// PageFetchClass type can't drift apart.
export const PAGE_FETCH_CLASSES = [
  "ok",
  "blocked",
  "rate_limited",
  "error",
] as const;

export type PageFetchClass = (typeof PAGE_FETCH_CLASSES)[number];
