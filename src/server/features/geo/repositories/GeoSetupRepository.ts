/**
 * Data access for GEO targets and prompt sets: the things you configure, as
 * opposed to the archive of answers you collect.
 *
 * Provider-aware (D1 or Postgres) via the `@/db` handle. Reads close over the
 * module-level `db`; every write takes `tx` first and returns an *unawaited*
 * builder, so a caller can compose a whole setup into one atomic `runBatch`.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import type { runBatch } from "@/db/runBatch";
import { geoPrompts, geoPromptSets, geoTargets } from "@/db/schema";
import { normaliseDomain } from "@/server/features/geo/domain";

/** The write handle `runBatch` hands its callback. */
export type GeoTx = Parameters<Parameters<typeof runBatch>[0]>[0];

export type GeoTargetRow = typeof geoTargets.$inferSelect;
export type GeoPromptSetRow = typeof geoPromptSets.$inferSelect;
export type GeoPromptRow = typeof geoPrompts.$inferSelect;

/** The intents a prompt can be classified as, matching the schema's enum. */
const PROMPT_INTENTS = [
  "informational",
  "commercial",
  "transactional",
  "navigational",
] as const;
export type GeoPromptIntent = (typeof PROMPT_INTENTS)[number];

/**
 * The AI platforms we store answers for. Kept as an explicit union because
 * Drizzle types `eq(platform, ...)` against the column's enum: widening these
 * parameters to `string` silently disables the check that stops a typo'd
 * platform from becoming a confident empty result.
 *
 * The schema-parity test keeps this list honest against both dialects.
 */
export const GEO_PLATFORMS = [
  "chat_gpt",
  "gemini",
  "perplexity",
  "google_ai_overview",
] as const;
export type GeoPlatform = (typeof GEO_PLATFORMS)[number];

/**
 * The platforms whose retrieval list DataForSEO actually returns. Google AI
 * Overviews returns citations only — which is exactly why the citation gap is a
 * ChatGPT capability and must never be implied otherwise.
 */
export const RETRIEVAL_PLATFORMS: readonly GeoPlatform[] = ["chat_gpt"];

/** Narrow an untrusted string (MCP args, env) to a known platform. */
export function isGeoPlatform(value: unknown): value is GeoPlatform {
  return (
    typeof value === "string" &&
    (GEO_PLATFORMS as readonly string[]).includes(value)
  );
}

/** Whether a platform reports retrieval, so an empty gap can be explained. */
export function platformSupportsRetrieval(platform: GeoPlatform): boolean {
  return RETRIEVAL_PLATFORMS.includes(platform);
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

async function listTargets(projectId: string): Promise<GeoTargetRow[]> {
  return db
    .select()
    .from(geoTargets)
    .where(eq(geoTargets.projectId, projectId));
}

async function getTarget(
  projectId: string,
  targetId: string,
): Promise<GeoTargetRow | null> {
  const [row] = await db
    .select()
    .from(geoTargets)
    .where(
      and(eq(geoTargets.id, targetId), eq(geoTargets.projectId, projectId)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Upsert on the project+domain+market identity, so re-adding a brand from a
 * second surface (UI, agent, MCP) lands on the same row instead of creating a
 * duplicate that halves every share-of-voice number.
 */
function upsertTarget(tx: GeoTx, target: typeof geoTargets.$inferInsert) {
  return tx
    .insert(geoTargets)
    .values({ createdAt: new Date().toISOString(), ...target })
    .onConflictDoUpdate({
      target: [
        geoTargets.projectId,
        geoTargets.domain,
        geoTargets.locationCode,
        geoTargets.languageCode,
      ],
      set: { name: target.name, aliases: target.aliases ?? null },
    });
}

/** Resolve a typed intent, ignoring anything unrecognised rather than storing it. */
function toIntent(value: string | null | undefined): GeoPromptIntent | null {
  return PROMPT_INTENTS.find((intent) => intent === value) ?? null;
}

function deleteTarget(tx: GeoTx, projectId: string, targetId: string) {
  return tx
    .delete(geoTargets)
    .where(
      and(eq(geoTargets.id, targetId), eq(geoTargets.projectId, projectId)),
    )
    .returning({ id: geoTargets.id });
}

// ---------------------------------------------------------------------------
// Prompt sets
// ---------------------------------------------------------------------------

async function listPromptSets(projectId: string): Promise<GeoPromptSetRow[]> {
  return db
    .select()
    .from(geoPromptSets)
    .where(eq(geoPromptSets.projectId, projectId));
}

async function getPromptSet(
  projectId: string,
  promptSetId: string,
): Promise<GeoPromptSetRow | null> {
  const [row] = await db
    .select()
    .from(geoPromptSets)
    .where(
      and(
        eq(geoPromptSets.id, promptSetId),
        eq(geoPromptSets.projectId, projectId),
      ),
    )
    .limit(1);
  return row ?? null;
}

function insertPromptSet(tx: GeoTx, set: typeof geoPromptSets.$inferInsert) {
  return tx
    .insert(geoPromptSets)
    .values({ createdAt: new Date().toISOString(), ...set });
}

function deletePromptSet(tx: GeoTx, projectId: string, promptSetId: string) {
  return tx
    .delete(geoPromptSets)
    .where(
      and(
        eq(geoPromptSets.id, promptSetId),
        eq(geoPromptSets.projectId, projectId),
      ),
    )
    .returning({ id: geoPromptSets.id });
}

/**
 * Prompts for a set, in the curated order the set was built with. Scoped to
 * `projectId` even though the set id is already unique: a set belonging to
 * another project must not be readable by passing its id.
 */
async function listPrompts(
  projectId: string,
  promptSetId: string,
): Promise<GeoPromptRow[]> {
  const rows = await db
    .select({ prompt: geoPrompts })
    .from(geoPrompts)
    .innerJoin(geoPromptSets, eq(geoPrompts.promptSetId, geoPromptSets.id))
    .where(
      and(
        eq(geoPrompts.promptSetId, promptSetId),
        eq(geoPromptSets.projectId, projectId),
      ),
    )
    .orderBy(geoPrompts.position);
  return rows.map((row) => row.prompt);
}

/** Write a set's prompts, numbered in the order given. */
function insertPrompts(
  tx: GeoTx,
  promptSetId: string,
  prompts: Array<{ prompt: string; intent?: string | null }>,
) {
  return prompts.map((entry, index) =>
    tx.insert(geoPrompts).values({
      id: crypto.randomUUID(),
      promptSetId,
      prompt: entry.prompt,
      position: index,
      intent: toIntent(entry.intent),
      createdAt: new Date().toISOString(),
    }),
  );
}

/**
 * Find a target by any spelling the caller might paste.
 *
 * Returns null rather than throwing: a service asking about an unmonitored
 * domain decides how to phrase that, and a NOT_FOUND stack is not a sentence.
 *
 * **Both sides are normalised through the one shared function.** This used to
 * inline a second copy that stripped a scheme and a `www.` from the *argument*
 * only, and never touched the stored `row.domain`. So a target saved as
 * `acme.com/about` — a path a paste can easily include — never matched anything,
 * and the caller was told the brand was not monitored when it plainly was. That is
 * the exact failure `normaliseDomain`'s own docstring describes, committed in the
 * one function whose job is to prevent it.
 *
 * Normalising both sides also makes the comparison order-independent, which the
 * inline version was not: it compared the raw stored value first and only then
 * tried the stripped argument.
 */
async function getTargetByDomain(
  projectId: string,
  domain: string,
): Promise<GeoTargetRow | null> {
  const wanted = normaliseDomain(domain);
  const targets = await listTargets(projectId);
  return targets.find((row) => normaliseDomain(row.domain) === wanted) ?? null;
}

export const GeoSetupRepository = {
  listTargets,
  getTarget,
  getTargetByDomain,
  upsertTarget,
  deleteTarget,
  listPromptSets,
  getPromptSet,
  insertPromptSet,
  deletePromptSet,
  listPrompts,
  insertPrompts,
} as const;
