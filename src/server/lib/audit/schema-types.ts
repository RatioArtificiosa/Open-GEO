/**
 * schema.org type extraction from a JSON-LD block.
 *
 * ## Why this is its own module
 *
 * Not for tidiness. `page-analyzer.ts` was at the 400-line ceiling once this logic
 * went in, and the limit exists because a file nobody can hold in their head is a
 * file nobody reviews carefully. **The split was chosen to put a whole decision
 * behind one boundary**: everything here answers *"what does this block declare
 * itself to be?"*, and everything in the analyzer answers *"how do I walk this
 * document?"* A reader looking for the second never has to read the first.
 *
 * ## The two rules, and why they are what they are
 *
 * **1. Never `JSON.parse`.** Structured data on the open web is frequently
 * invalid — trailing commas, single quotes, raw newlines inside strings — and a
 * page whose markup is broken still has schema.org markup that a human and a
 * crawler can both read. `JSON.parse` throws on all of it, and one malformed
 * block would cost the page its entire structured-data reading. **A tolerant
 * scan that finds the label is worth more here than a correct parse that throws.**
 *
 * **2. Never trust the value.** A type name is a bounded, quoted token after the
 * key. Nothing else in the block is interpreted, and the bound keeps a data blob
 * containing the text `"@type"` from injecting an arbitrary string into a field
 * the citability rubric reads. The block is **data on a page we did not write**,
 * so it is read for one label and nothing more.
 */

/**
 * Is this `<script type>` a JSON-LD block?
 *
 * **A prefix test, not equality, and that is the fix.** The original check was
 * `type === "application/ld+json"`, so a page writing
 * `type="application/ld+json; charset=utf-8"` — legal, and emitted by several CMS
 * templating layers — was reported as having *no* structured data at all. The
 * parameter part of a MIME type is separated by a semicolon and ignored for
 * matching, so it must be ignored here too.
 *
 * Case-insensitive as well: the tokenizer lowercases attribute *names* but not
 * their values, and `application/LD+JSON` appears in the wild.
 */
export function isJsonLdScript(type: string | undefined): boolean {
  if (type === undefined) return false;
  const essence = type.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return essence === "application/ld+json";
}

/**
 * The schema.org `@type` names in one JSON-LD block, deduplicated, in order.
 *
 * `@type` is either a string or an array of strings, and both forms carry a
 * quoted token after the key. **Both quote styles are accepted**, because
 * single-quoted JSON is at least as common in hand-written blocks as
 * double-quoted, and a pattern that only reads one of them reports "no
 * structured data" for a page that plainly has some — a confident wrong answer
 * rather than an obvious omission, which is the worse failure.
 *
 * A multi-entry array keeps only its first **two** names. The rubric asks
 * whether a page declares its subject type at all, and an array of fifty URLs
 * from a CMS template should not become fifty rubric inputs.
 */
function extractSchemaTypes(jsonLd: string): string[] {
  const types: string[] = [];
  const pattern =
    /["']@type["']\s*:\s*(?:["']([A-Za-z][A-Za-z0-9]{0,63})["']|\[\s*["']([A-Za-z][A-Za-z0-9]{0,63})["'](?:\s*,\s*["']([A-Za-z][A-Za-z0-9]{0,63})["'])*\s*\])/g;
  let match: RegExpExecArray | null = pattern.exec(jsonLd);
  while (match !== null) {
    // Either the single-value capture or one of the array-entry captures holds the
    // name; the rest are `undefined` because the alternatives did not participate.
    for (const candidate of [match[1], match[2], match[3]]) {
      if (candidate === undefined) continue;
      if (!types.includes(candidate)) types.push(candidate);
    }
    match = pattern.exec(jsonLd);
  }
  return types;
}

/**
 * Appends the types from a JSON-LD body to `schemaTypes`, skipping any already there.
 *
 * A function for the same reason as the heading flush beside it: every write to
 * the buffer happens inside a parser callback, and TypeScript's flow analysis
 * treats a closure's assignments as invisible — so reading it after the parse
 * narrows it to `never`. Both buffers have the same shape of problem and both are
 * asked for rather than assumed.
 *
 * Deduplicating *across* blocks is the point of routing both the close-tag path
 * and any other flush through here. A page declaring `Article` in three separate
 * blocks reports it once: the rubric asks whether the type is present, and a page
 * cannot be more citatable for repeating itself. An earlier version pushed here
 * directly on the close-tag path and only deduplicated within a single block, so
 * multi-block pages came back with `["Article", "Article", "WebPage"]`.
 */
export function flushSchemaTypes(schemaTypes: string[], open: string[]): void {
  for (const type of extractSchemaTypes(open.join(""))) {
    if (!schemaTypes.includes(type)) schemaTypes.push(type);
  }
}
