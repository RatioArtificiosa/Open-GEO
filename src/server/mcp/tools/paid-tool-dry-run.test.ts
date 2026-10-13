import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { wantsToSpend as wantsToSpendFromModule } from "@/server/mcp/dry-run";

/**
 * CL-058: every tool that spends has a price an agent can ask for first.
 *
 * ## The requirement, stated as a rule about the surface rather than a tool
 *
 * An agent that knows nothing about OpenGeo must be able to ask what a call
 * costs without spending on it. Measured when this was written: one tool in
 * fifty took `dry_run`, and it was correct precisely because it **defaulted to
 * true** — the tools that omitted it spent on the first call.
 *
 * A per-tool test cannot hold that. The rule is about the *surface*: a tool
 * added next month, by someone who has not read this file, must not be able to
 * ship a paid handler with no preview. So the check is a source scan, and it is
 * the same shape as `billed-tasks-gate` and the platform card rule — because the
 * defect lives in the code that *reaches for* a spend, not in any single input.
 *
 * ## Per handler, not per file
 *
 * Seven of these files hold several tools, so "the file mentions dry_run" is not
 * the rule: a single `dry_run` in a file with five handlers is the pattern with
 * four holes in it. The count is therefore of **handlers that do not check
 * `args.dry_run`**.
 *
 * ## And the free tools are named, not inferred
 *
 * `list_business_categories` reads the vendor's category table through the
 * **reference cache** and never touches the metered client — it is the one tool
 * in the paid surface whose `handles` contains no client call at all, and its
 * own test says "Free endpoint: must never touch the metered client (a
 * zero-credit org would otherwise be refused by the credit gate)". A rule that
 * demanded a `dry_run` of it would be demanding a price for something that is
 * free, which is the wrong claim.
 *
 * It is listed by name because a detector that *infers* free from the absence of
 * a client call would also exempt a paid handler whose call was refactored into
 * a helper — and then the gate would silently stop covering exactly the tools it
 * needs to cover. A named exemption with a reason is visible; an inferred one is
 * a hole that widens without anyone noticing.
 *
 * `get_page_waterfall` joins it, for the opposite reason: it **does** reach the
 * vendor, but the read is unmetered at both ends. Its first version previewed
 * `0 credits`, which is worse than no preview — the field defaults to preview,
 * so an agent following its own instructions would call the preview instead of
 * the read it wants.
 */

const TOOLS_DIR = join(process.cwd(), "src/server/mcp/tools");

/**
 * Tools that make a vendor call yet cost nothing. See the header.
 *
 * The names are the **MCP tool names**, which is what the scan reads from
 * `name: "…"`, not the export names — mixing the two is how the exemption
 * silently stops matching.
 */
const FREE_TOOLS = new Set(["list_business_categories", "get_page_waterfall"]);

function toolFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        out.push(full);
      }
    }
  };
  walk(TOOLS_DIR);
  return out;
}

/** Does this file call the vendor at all? */
function spends(file: string): boolean {
  const source = readFileSync(file, "utf8");
  return (
    /createDataforseoClient/.test(source) ||
    /dataforseoPost/.test(source) ||
    /dataforseoGet/.test(source)
  );
}

/**
 * Every handler declaration in a file, as the tool it belongs to and the body it
 * runs.
 *
 * The body runs to the end of the handler's object entry, found by depth
 * counting plus "a line that is only closing punctuation" — **not** by matching
 * `  },`.** A handler that opens with the multi-line `withMcpProjectAuth(` form
 * closes at four spaces, not two, and an indent-exact match reads to the end of
 * the file; that is how this gate's first version reported every tool in
 * `local-seo-tools.ts` as one unguarded handler.
 */
function handlersOf(source: string): { tool: string; body: string }[] {
  const found: { tool: string; body: string }[] = [];
  const lines: string[] = source.split("\n");
  let tool = "";
  for (let i = 0; i < lines.length; i += 1) {
    const nameMatch = /^\s*name:\s*"([^"]+)",/.exec(lines[i] ?? "");
    if (nameMatch) {
      tool = nameMatch[1] ?? "";
      continue;
    }
    if (!/^\s*handler:\s*withMcpProjectAuth/.test(lines[i] ?? "")) continue;
    let depth = 0;
    let body = "";
    for (let j = i; j < lines.length; j += 1) {
      const line = lines[j] ?? "";
      body += `${line}\n`;
      for (const ch of line) {
        if (ch === "{" || ch === "(" || ch === "[") depth += 1;
        else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
      }
      if (
        depth <= 0 &&
        j > i &&
        isOnlyClosingPunctuation(line) &&
        line.trim() !== ""
      )
        break;
    }
    found.push({ tool, body });
  }
  return found;
}

/** Does this predicate spend on the default — the omitted ? */
function spendsOnOmitted(
  wantsToSpend: (dryRun: boolean | undefined) => boolean,
): boolean {
  return wantsToSpend(undefined);
}

/** The defect, as a value: preview only when  is explicitly true. */
const invertedWantsToSpend = (dryRun: boolean | undefined) => dryRun !== true;

/**
 * A line whose only content is closing punctuation, which ends an object entry.
 *
 * **The pattern is spelled with character escapes on purpose.** A hand-edit once
 * collapsed this to `/^s*[})],s]*$/` — no backslashes — which matches nothing, and
 * every handler body then read to the end of the file. The suite stayed green
 * because each body contained all the others, so `args.dry_run` was present in
 * every one of them: a gate that passes because it sees *everything* is the same
 * failure as one that sees nothing.
 */
function isOnlyClosingPunctuation(line: string): boolean {
  return /^\s*[})\],\s]*$/.test(line) && line.trim() !== "";
}

const files = toolFiles();
const paying = files.filter(spends);
const unguarded: string[] = [];
const handlerCount = { free: 0, paid: 0 };

for (const file of paying) {
  const relative = file.slice(TOOLS_DIR.length + 1);
  const handlers = handlersOf(readFileSync(file, "utf8"));
  for (const handler of handlers) {
    if (FREE_TOOLS.has(handler.tool)) {
      handlerCount.free += 1;
      continue;
    }
    // A handler with no vendor call of its own is a tool whose spend was moved
    // into a helper; it still needs the preview at the seam, or the caller is
    // quoted nothing and charged something.
    handlerCount.paid += 1;
    if (!/args\.dry_run/.test(handler.body)) {
      unguarded.push(`${relative}: ${handler.tool}`);
    }
  }
}

describe("every paid MCP tool offers a cost preview", () => {
  it("reads a real number of tool files", () => {
    // The vacuity guard: a scan of the wrong directory passes forever by
    // finding nothing, and that is the one failure mode a gate cannot recover
    // from by being merely wrong.
    expect(files.length).toBeGreaterThan(30);
    expect(paying.length).toBeGreaterThan(5);
  });

  it("finds the handlers it is meant to cover", () => {
    expect(handlerCount.paid).toBeGreaterThan(15);
    // The exemption is load-bearing in the other direction too: if it stops
    // being exempt, the count below goes to zero and the exemption is dead
    // weight rather than a decision.
    expect(handlerCount.free).toBeGreaterThan(0);
  });

  it("checks args.dry_run in every paid handler", () => {
    expect(unguarded).toEqual([]);
  });

  it("declares dry_run on every paid tool's input schema", () => {
    // Either spelling: the shared spread, or the field declared inline on a
    // tool that predates the helper. What matters is that the arguments type
    // carries the field, which is what `args.dry_run` reading proves — so this
    // is a second assertion about the same property, not the rule itself.
    const offenders: string[] = [];
    for (const file of paying) {
      const relative = file.slice(TOOLS_DIR.length + 1);
      const source = readFileSync(file, "utf8");
      const declaresDryRun =
        /dryRunInputSchema/.test(source) || /dry_run:/.test(source);
      if (!declaresDryRun) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it("would catch a paid handler that omits the preview", () => {
    // The negative control. A handler with no `args.dry_run` is the defect, and
    // this is the shape of it — the exact string a tool written before this rule
    // had.
    const paidHandlerWithoutPreview = [
      "  handler: withMcpProjectAuth(async (args: Args, context) => {",
      "    const client = createDataforseoClient(context.billing);",
      "    const rows = await client.serp.organic(args);",
      "    return mcpResponse({ text: format(rows) });",
      "  }),",
    ].join("\n");
    expect(/args\.dry_run/.test(paidHandlerWithoutPreview)).toBe(false);
  });

  it("would catch the inverted default", () => {
    // The whole rule is the default, so a preview that reads
    // `dry_run !== true` instead of `dry_run === false` passes every test that
    // opts out explicitly and fails the only caller the rule is for.
    //
    // The inverted form **spends on `undefined`**: an agent that omits the field
    // is billed, and that is the assertion. The correct form does not.
    expect(spendsOnOmitted(invertedWantsToSpend)).toBe(true);
    expect(spendsOnOmitted(wantsToSpendFromModule)).toBe(false);
    // Both forms agree on the explicit opt-out, which is exactly why a test
    // that only ever passes `false` cannot tell them apart.
    expect(invertedWantsToSpend(false)).toBe(true);
  });
});
