/**
 * Turning a value into a storable evidence string.
 *
 * Its own module, separate from the recorder, for one reason: **this is pure and
 * that is testable.** The recorder is I/O and the tests would need a database;
 * the truncation rules are the part where a silent mistake corrupts a
 * re-derivation, so they are the part worth testing directly.
 */

/**
 * Byte caps per field.
 *
 * Two numbers, not one, and the asymmetry is deliberate. A `responseBody` is
 * capped low because a Lighthouse payload is multiple megabytes and a D1 row has
 * a practical ceiling. A `requestBody` is capped far higher because a request we
 * cannot reproduce *is* the failure the evidence table exists to prevent, and
 * requests are small by construction.
 */
export const EVIDENCE_LIMITS = {
  requestBody: 60_000,
  responseBody: 200_000,
} as const;

/**
 * Serialise for storage, truncating with an explicit marker.
 *
 * Every truncation is marked with how much was dropped, because a silently
 * shortened body produces a re-derivation that looks correct and is not. That
 * is worse than an absent body: absent is honest, wrong is not.
 *
 * A string longer than the cap keeps its head and gains the marker. Anything
 * else is JSON-encoded first, so the column stays one type.
 */
export function serialiseForEvidence(
  value: unknown,
  cap: number,
): string | null {
  if (value === undefined) return null;

  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  } catch {
    // A circular structure or a BigInt. The call this describes is unaffected;
    // only its evidence is lost, and losing it must never throw.
    return "[unserialisable]";
  }

  if (text === "") return null;
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}…[truncated at ${cap} of ${text.length} chars]`;
}
