import type { CallToolResult } from "@modelcontextprotocol/server";

type McpResponseMeta = {
  url?: string;
  projectId?: string;
  runId?: string;
  creditsCharged?: number;
  creditsRemaining?: number;
};

// The generic overload preserves each tool's concrete structuredContent shape
// so tests (and callers) can access fields without casting. The type parameter
// appears in exactly one position — a required `structuredContent: T` — which
// is what makes inference work; a `T` shared between an optional field and an
// intersection member collapses to `{}`.
export function mcpResponse<T extends Record<string, unknown>>(opts: {
  text: string;
  meta?: McpResponseMeta;
  structuredContent: T;
}): CallToolResult & {
  structuredContent: T & { meta?: Record<string, unknown> };
};
export function mcpResponse(opts: {
  text: string;
  meta?: McpResponseMeta;
}): CallToolResult;
export function mcpResponse(opts: {
  text: string;
  meta?: McpResponseMeta;
  structuredContent?: Record<string, unknown>;
}): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text: opts.text }],
  };
  let meta: Record<string, unknown> | undefined;
  if (opts.meta) {
    meta = {};
    for (const [key, value] of Object.entries(opts.meta)) {
      if (value !== undefined) meta[key] = value;
    }
  }
  const hasMeta = meta != null && Object.keys(meta).length > 0;
  if (opts.structuredContent) {
    result.structuredContent = hasMeta
      ? { ...opts.structuredContent, meta }
      : opts.structuredContent;
  } else if (hasMeta) {
    result.structuredContent = { meta };
  }
  if (hasMeta) {
    result._meta = meta;
  }
  return result;
}

/**
 * A short preview of a long text field for a list response. mcpResponse puts
 * `text` AND `structuredContent` on the wire and clients count both, so a list
 * page carries every preview twice — full summaries or instructions at their
 * caps would be tens of KB on the one call every agent is told to make first.
 * The single-item read is where the whole field is returned.
 *
 * The cut is clamped back a step if it would land inside a surrogate pair: a
 * lone surrogate renders as a replacement glyph, and this string ends up quoted
 * straight back to a user by the agent reading it.
 */
export const truncatePreview = (value: string, max = 300) => {
  if (value.length <= max) return value;
  let cut = value.slice(0, max).trimEnd();
  // A high surrogate at the end means the pair was split; drop it.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
};

/**
 * Roughly how many characters a response puts on the wire.
 *
 * Not a token count — tokenizers vary too much for that to be a useful contract.
 * It is a *size* measure in the unit the code can actually control, and it exists
 * because "this response is compact" is a claim worth nothing until something
 * counts it.
 */
export function estimateResponseTokens(result: CallToolResult): number {
  const text = result.content.reduce(
    (sum, part) => sum + (part.type === "text" ? part.text.length : 0),
    0,
  );
  const structured =
    result.structuredContent === undefined
      ? 0
      : JSON.stringify(result.structuredContent).length;
  return text + structured;
}

type OptimizeOptions = {
  /**
   * Fields to keep. Everything else is dropped and named in `_dropped`.
   * Omit to keep every key except any the budget cannot afford.
   */
  keep?: string[];
  /** Soft ceiling for the serialised result. */
  budgetChars?: number;
  /** Cap on array length per key, with the true length recorded. */
  maxItemsPerKey?: number;
};

/**
 * Keys that are never dropped, whatever the budget says.
 *
 * `meta` carries the dashboard link and the credits spent — the two things an
 * agent needs to tell the user what happened and where to look. Dropping them to
 * hit a byte count would leave a response that is small and useless.
 */
const NEVER_DROP = new Set(["meta", "_dropped", "_truncated"]);

/** How many dropped key names `_dropped` will list before summarising. */
const MAX_DROPPED_NAMES = 12;

/**
 * Trim a payload for the model, and say what was trimmed.
 *
 * The reason this exists rather than a `.ai` response format: **there is no such
 * format.** Checked against the shipped `ai@7.0.122` bundle — no `toAIResponse`,
 * no `.v1.ai.json` — and `@ai-sdk/mcp`'s built-in `toModelOutput` is a 1:1 wire
 * shim that passes text through verbatim and saves nothing. The real lever is
 * returning less, which is what this does.
 *
 * Every trim is **recorded, never silent**, and that is the whole design:
 *
 * - `_dropped` lists keys removed, so an agent can go fetch exactly what it
 *   needs rather than guessing.
 * - `_truncated` lists arrays cut, with the count it *had* — without it, five
 *   visible pages read as "these are all the pages", and the agent tells the
 *   customer their brand is cited by five.
 *
 * A silently shortened payload is worse than a large one: the model has no way to
 * know.
 */
export function optimizeForModel<T extends Record<string, unknown>>(
  payload: T,
  options: OptimizeOptions = {},
): Partial<T> & { _dropped?: string[]; _truncated?: Record<string, number> } {
  const { keep, budgetChars, maxItemsPerKey } = options;

  const dropped: string[] = [];
  const truncated: Record<string, number> = {};
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (key === "meta") {
      // Meta is the one field an agent needs to act (the dashboard link, the
      // credits spent), and it is small.
      out[key] = value;
      continue;
    }
    if (keep && !keep.includes(key)) {
      dropped.push(key);
      continue;
    }
    if (
      maxItemsPerKey !== undefined &&
      Array.isArray(value) &&
      value.length > maxItemsPerKey
    ) {
      truncated[key] = value.length;
      out[key] = value.slice(0, maxItemsPerKey);
      continue;
    }
    out[key] = value;
  }

  // Budget last, and only if the caller asked. Dropping whole keys beats
  // truncating values, because a partial value is still a value the model may
  // read as complete.
  //
  // Arrays are halved first — a long list is the one field that is cheap to
  // shorten and the most likely to be a list the model only needed the shape
  // of — and only then do whole keys go, largest first. `NEVER_DROP` can leave
  // the result over budget, and that is deliberate: a budget that quietly does
  // not hold is worse than a small response missing its dashboard link.
  if (budgetChars !== undefined) {
    for (const [key, value] of Object.entries(out)) {
      if (JSON.stringify(out).length <= budgetChars) break;
      if (NEVER_DROP.has(key) || !Array.isArray(value)) continue;
      // Halve, but never to nothing: an empty array tells the model the answer
      // is "none", which is a claim, and the key-drop loop below would delete it
      // outright a moment later. If one halving is not enough, the honest
      // outcome is to drop the key and name it in `_dropped`.
      if (!truncated[key]) truncated[key] = value.length;
      const halved = value.slice(0, Math.floor(value.length / 2));
      if (halved.length === 0) continue;
      out[key] = halved;
    }
    while (JSON.stringify(out).length > budgetChars) {
      // `toSorted` is not on this project's lib target and the linter rejects a
      // bare `sort`, so the ordering is done by hand. The list is a handful of
      // keys and this runs once per over-budget response.
      const ranked = Object.entries(out).filter(
        ([key]) => !NEVER_DROP.has(key),
      );
      let largestKey: string | null = null;
      let largestSize = -1;
      for (const [key, value] of ranked) {
        const size = JSON.stringify(value).length;
        if (size > largestSize) {
          largestSize = size;
          largestKey = key;
        }
      }
      if (largestKey === null) break;
      dropped.push(largestKey);
      delete out[largestKey];
    }
  }

  // `_dropped` is capped for the same reason the payload is: a result listing
  // 48 dropped keys is a result that blew the budget while explaining why it did
  // not. The cap is generous because the list exists so an agent knows *what it
  // can go and ask for*, not so it can read all of it.
  if (dropped.length > MAX_DROPPED_NAMES) {
    out._dropped = [
      ...dropped.slice(0, MAX_DROPPED_NAMES),
      `+${dropped.length - MAX_DROPPED_NAMES} more`,
    ];
  } else if (dropped.length > 0) {
    out._dropped = dropped;
  }
  if (Object.keys(truncated).length > 0) out._truncated = truncated;

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `out` is built key by key above and the audit fields are assigned to it; a structural clone here would lose the narrow `T` keys the caller asked for
  return out as Partial<T> & {
    _dropped?: string[];
    _truncated?: Record<string, number>;
  };
}
