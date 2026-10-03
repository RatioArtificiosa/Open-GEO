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

/**
 * The JSON body the first recorded `fetch` call was made with, parsed.
 *
 * **Synchronous because every DataForSEO client in this directory sends a string
 * body.** The first version of the anchors test read `init.body` with an `await` on the
 * assumption it could be a `ReadableStream` — `await` on a string is legal and silently
 * returns the string, so the test passed and would have kept passing even if the body were
 * never sent at all. A body assertion that cannot fail is not a body assertion.
 *
 * The check is explicit rather than a cast, so a client that switches to a `Request` fails
 * here with a readable message instead of parsing `undefined`.
 */
export function requestBody(
  mock: FetchMock,
  callIndex = 0,
): Record<string, unknown>[] {
  const second = mock.mock.calls[callIndex]?.[1];
  if (second === undefined) {
    throw new Error(
      `fetch call ${callIndex} had no second argument, so it sent no body`,
    );
  }
  // **Narrowed rather than asserted.** Casting `unknown` to `{ body?: unknown }` is
  // *narrower* than the value it came from, which is exactly what
  // `no-unsafe-type-assertion` rejects: it would wave a `ReadableStream` through and let
  // `JSON.parse` fail on it at runtime instead of here with a readable message.
  if (typeof second !== "object" || second === null || !("body" in second)) {
    throw new Error(
      `fetch call ${callIndex} sent no init object, so requestBody cannot read it`,
    );
  }
  const { body } = second;
  if (typeof body !== "string") {
    throw new Error(
      `fetch call ${callIndex} sent a ${typeof body} body, not a JSON string, ` +
        "so requestBody cannot parse it — update this helper rather than casting",
    );
  }
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `A DataForSEO POST body is a task array; call ${callIndex} sent a ${typeof parsed}`,
    );
  }
  // **Filtered by a type guard, not cast** — a task array of primitives would otherwise be
  // typed as records and the first property access on `0` would be `undefined` at runtime
  // with no complaint from the compiler.
  return parsed.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null,
  );
}
