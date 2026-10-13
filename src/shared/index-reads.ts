/**
 * Index reads a caller can rely on.
 *
 * In the shared layer because both production code and tests need the same
 * guarantee, and a test-only copy would drift from the one the product uses.
 *
 * ## Why this exists
 *
 * `noUncheckedIndexedAccess` makes every index read `T | undefined`, which is
 * correct and also unusable at call sites that have already proven the index is
 * present — a loop guard, a `.filter()` that cannot be empty, a lookup on a key
 * the caller supplied. Before this helper those sites took one of two roads, both
 * bad: a `!` assertion that silences the compiler without adding information, or
 * an `if (x === undefined) throw` repeated at every site with a different message
 * each time.
 *
 * `first()` is not a safer `!`. It converts a silent `undefined` into a named
 * failure that says which call, and what the array actually held.
 */

/** Read the first element of a non-empty array, or fail with the context. */
export function first<T>(items: readonly T[], context: string): T {
  const head = items[0];
  if (head === undefined) {
    throw new Error(
      `${context}: expected at least one item, the array was empty`,
    );
  }
  return head;
}

/**
 * The first character of a non-empty string.
 *
 * **Why this exists alongside `first()`.** `first()` takes `readonly T[]`, so a
 * string would need `[...s]` — which the lint rejects twice over
 * (`no-misused-spread` splits an emoji into its code points, and
 * `no-array-reverse` rejects the reverse used to reach the last one). That is
 * the same destination by a worse road: the `noUncheckedIndexedAccess`
 * conversion this file exists for produced `at([brand], brand.length - 1, …)`,
 * which reads past the end of a one-element array and returns `undefined` for
 * every brand of two or more characters.
 *
 * `brand[0]` under the flag is `string | undefined`, and an escaped `undefined`
 * builds a pattern that matches everything, so the narrowing has to be
 * explicit. `slice` is the one read the compiler accepts without a branch, and
 * it is correct for every string, including the astral-plane case the spread
 * breaks.
 */
export function firstChar(text: string, context: string): string {
  if (text.length === 0) {
    throw new Error(`${context}: expected at least one character`);
  }
  return text.slice(0, 1);
}

/** The last character of a non-empty string. The mirror of `firstChar`. */
export function lastChar(text: string, context: string): string {
  if (text.length === 0) {
    throw new Error(`${context}: expected at least one character`);
  }
  return text.slice(-1);
}

/** Read the element at an index that must be present, or fail with the context. */
export function at<T>(items: readonly T[], index: number, context: string): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(
      `${context}: expected an item at index ${index}, the array holds ${items.length}`,
    );
  }
  return value;
}

/**
 * Read a `Record` entry that must be present, or fail with the key.
 *
 * **Why this is separate from `at()`.** `at()` narrows an array index, where
 * presence is a question about length. A `Record` lookup is a different
 * question — the key either was set or it was not — and `at()` cannot express it
 * because a Record is not an array. Passing one to `at()` is a type error.
 *
 * The case this covers is the same one `at()` does: the caller has established
 * that the key is present, and a silent `undefined` would be read downstream as
 * though it were a value.
 */
export function keyed<T>(
  record: Record<string, T | undefined>,
  key: string,
  context: string,
): T {
  const value = record[key];
  if (value === undefined) {
    throw new Error(
      `${context}: no entry for "${key}" (the record holds ${Object.keys(record).length})`,
    );
  }
  return value;
}

/**
 * The arguments a mock was called with, for the call at an index.
 *
 * **Why this is here rather than a destructure at the use site.**
 * `spy.mock.calls[0]` is typed `any[]` by vitest when the mock is not given a
 * call signature, so destructuring it hands out `any` twice over — which is
 * what the `no-unsafe-*` rules report, and what the assertions downstream then
 * quietly accept. `noUncheckedIndexedAccess` makes the index read visible as
 * well, so the same line produces both an unsafe-value error and a
 * possibly-undefined one.
 *
 * Asserting on a call that never happened is also a failing test that reads
 * like a passing one: `mock.calls[0]` against a spy never invoked is
 * `undefined`, and the expectation that follows reports a confusing message
 * about `undefined` rather than about the call that is missing.
 *
 * The `spy` parameter is shaped structurally rather than typed as vitest's
 * `Mock`, because importing vitest's types into the shared layer would make
 * production code depend on the test framework's types.
 */
export function callArgs<T extends unknown[]>(
  spy: { mock: { calls: T[] } },
  index: number,
  context: string,
): T {
  const call = spy.mock.calls[index];
  if (call === undefined) {
    throw new Error(
      `${context}: the mock was called ${spy.mock.calls.length} time(s), so there is no call at index ${index}`,
    );
  }
  return call;
}
