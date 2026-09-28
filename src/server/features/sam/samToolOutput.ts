// Every tool result SAM sees is persisted into the transcript and re-sent to
// the model on each later step of the turn, so one oversized payload (a keyword
// list with hundreds of rows, ten scraped pages) is paid for dozens of times —
// and it is how long SAM turns outgrew the Durable Object memory limit in
// Sep 2026. Trim any result over the budget before it reaches the model and
// say what was dropped, so the model narrows the request instead of guessing.
// The MCP server hands external clients the full payload; only SAM is capped.

const SAM_MAX_TOOL_OUTPUT_CHARS = 32_000;
// A single long string (a scraped page) never gets more than this share.
const MAX_STRING_CHARS = 8_000;
const MIN_STRING_CHARS = 500;
// Reserved for the `truncated` note, so the note can't push a trimmed result
// back over the cap.
const NOTE_BUDGET_CHARS = 600;

type Trim = {
  path: string;
  kept: number;
  total: number;
  unit: "rows" | "chars";
};

type Slot = { parent: object; key: string | number; path: string };

const size = (value: unknown): number => JSON.stringify(value)?.length ?? 0;

// Every array/string slot in the value, depth-first, with its dotted path.
function slots(value: unknown, path = ""): Slot[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const itemPath = `${path}[${index}]`;
      const here: Slot[] =
        Array.isArray(item) || typeof item === "string"
          ? [{ parent: value, key: index, path: itemPath }]
          : [];
      return [...here, ...slots(item, itemPath)];
    });
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => {
      const itemPath = path ? `${path}.${key}` : key;
      const here: Slot[] =
        Array.isArray(item) || typeof item === "string"
          ? [{ parent: value, key, path: itemPath }]
          : [];
      return [...here, ...slots(item, itemPath)];
    });
  }
  return [];
}

const read = (slot: Slot): unknown => Reflect.get(slot.parent, slot.key);
const write = (slot: Slot, value: unknown): void => {
  Reflect.set(slot.parent, slot.key, value);
};

// Trims are keyed per shape, not per element: 500 shortened `rows[i].body`
// strings are one note line, `rows[*].body`.
const shape = (path: string): string => path.replace(/\[\d+\]/g, "[*]");

// Whether a shape path still points at something in the trimmed value — the
// note must not describe rows the halving loop has since dropped.
function present(value: unknown, path: string): boolean {
  let node = value;
  for (const segment of path.split(/\.|(?=\[)/)) {
    if (segment === "") continue;
    if (segment === "[*]") {
      if (!Array.isArray(node) || node.length === 0) return false;
      node = node[0];
      continue;
    }
    if (typeof node !== "object" || node === null) return false;
    node = Reflect.get(node, segment);
    if (node === undefined) return false;
  }
  return true;
}

function note(trims: Trim[]): string {
  const parts = trims.map((trim) =>
    trim.unit === "rows"
      ? `\`${trim.path}\` shows ${trim.kept} of ${trim.total} rows`
      : `\`${trim.path}\` shortened to ${trim.kept} chars`,
  );
  const text = `Output trimmed to fit the chat context: ${parts.join("; ")}. Narrow the request (filters, a smaller limit, fewer pages) to see the rest.`;
  return text.length > NOTE_BUDGET_CHARS
    ? `${text.slice(0, NOTE_BUDGET_CHARS - 1)}…`
    : text;
}

/**
 * Returns `value` unchanged when it serializes under `maxChars`. Otherwise
 * returns a trimmed deep copy: long strings are capped first, then the
 * largest array is halved (keeping the head — results are ordered by
 * relevance) until it fits, then the longest string, with a `truncated` note
 * listing what was cut. The note is included in the cap.
 */
export function capToolOutput(
  value: unknown,
  maxChars = SAM_MAX_TOOL_OUTPUT_CHARS,
): unknown {
  if (size(value) <= maxChars) return value;

  const budget = maxChars - NOTE_BUDGET_CHARS;
  const copy: unknown = structuredClone(value);
  const trims = new Map<string, Trim>();
  const record = (
    slot: Slot,
    kept: number,
    total: number,
    unit: Trim["unit"],
  ) => {
    const path = shape(slot.path);
    const existing = trims.get(path);
    trims.set(path, {
      path,
      kept: existing ? Math.min(existing.kept, kept) : kept,
      total: existing ? Math.max(existing.total, total) : total,
      unit,
    });
  };

  for (const slot of slots(copy)) {
    const item = read(slot);
    if (typeof item === "string" && item.length > MAX_STRING_CHARS) {
      write(slot, item.slice(0, MAX_STRING_CHARS));
      record(slot, MAX_STRING_CHARS, item.length, "chars");
    }
  }

  while (size(copy) > budget) {
    const largest = slots(copy)
      .map((slot) => ({ slot, item: read(slot) }))
      .filter(
        (entry): entry is { slot: Slot; item: unknown[] } =>
          Array.isArray(entry.item) && entry.item.length > 1,
      )
      .reduce<{ slot: Slot; item: unknown[] } | undefined>(
        (best, entry) =>
          best && size(best.item) >= size(entry.item) ? best : entry,
        undefined,
      );
    if (!largest) break;
    const kept = Math.ceil(largest.item.length / 2);
    write(largest.slot, largest.item.slice(0, kept));
    record(largest.slot, kept, largest.item.length, "rows");
  }

  while (size(copy) > budget) {
    const longest = slots(copy)
      .map((slot) => ({ slot, item: read(slot) }))
      .filter(
        (entry): entry is { slot: Slot; item: string } =>
          typeof entry.item === "string" &&
          entry.item.length > MIN_STRING_CHARS,
      )
      .reduce<{ slot: Slot; item: string } | undefined>(
        (best, entry) =>
          best && best.item.length >= entry.item.length ? best : entry,
        undefined,
      );
    if (!longest) break;
    const kept = Math.max(MIN_STRING_CHARS, Math.ceil(longest.item.length / 2));
    write(longest.slot, longest.item.slice(0, kept));
    record(longest.slot, kept, longest.item.length, "chars");
  }

  const truncated = note(
    [...trims.values()].filter((trim) => present(copy, trim.path)),
  );
  // Slicing after the initial clone can retain the original large strings.
  // Detach the finished output before it enters the transcript.
  return structuredClone(
    typeof copy === "object" && copy !== null && !Array.isArray(copy)
      ? { ...copy, truncated }
      : { data: copy, truncated },
  );
}
