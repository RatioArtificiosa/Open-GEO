/**
 * Test helpers for asserting where a DataForSEO client actually sent its request.
 *
 * ## Why this exists
 *
 * A mocked `fetch` accepts any URL you hand it, so a test that only checks the
 * request **body** passes happily while the client points at a path that does not
 * exist. The `ai-keywords` client shipped that way: 14 green tests, and a URL
 * reading `ai_keyword_data/keywords/search_volume` where the API expects
 * `keywords_search_volume`. Nothing failed until a customer was billed for a
 * 40501.
 *
 * So the assertion has to be on the **destination**, and it has to unwrap
 * `RequestInfo` correctly to do it.
 */

/** A `vi.fn()` whose recorded calls are readable. */
type FetchMock = { mock: { calls: unknown[][] } };

/**
 * The URL the first recorded `fetch` call was made with.
 *
 * `fetch` accepts `string | URL | Request`, so `String(call)` is unsafe: a
 * `Request` stringifies to `[object Object]`, and a path assertion built on that
 * passes for entirely the wrong reason — which is worse than no assertion,
 * because it looks green. `no-base-to-string` is right to flag the shortcut.
 */
export function requestUrl(mock: FetchMock): string {
  const first = mock.mock.calls[0]?.[0];
  if (typeof first === "string") return first;
  if (first instanceof URL) return first.toString();
  if (first !== null && typeof first === "object" && "url" in first) {
    // Narrowed by the `in` check, so the read is a real property access rather
    // than an assertion over something that might not be a Request.
    return String(first.url);
  }
  throw new Error(
    "fetch was not called with a string, URL, or Request, so its URL cannot be asserted",
  );
}
