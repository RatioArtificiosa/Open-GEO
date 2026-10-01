import { normaliseUrlForJoin } from "./urlIdentity";

/**
 * The identity of an observation: which brand, on which platform, asked which
 * question.
 *
 * ## Why the brand is part of it
 *
 * The patrol asks **every target in the project the same prompt set**, so two
 * brands produce two answers for one prompt on one platform. Keying on
 * `platform|prompt` alone made those collide: the second brand's row was
 * discarded as a duplicate, and the survivor was compared against whichever
 * brand the previous run happened to keep — so a change in one brand could be
 * reported as a change in the other. A "you lost this mention" alert is something
 * a customer acts on, and acting on the wrong brand is worse than no alert.
 *
 * This lives apart from the reader because **both** sides of a comparison need it:
 * the reader keys what it reads, and `alertDecision` keys what it diffs. Two
 * copies of an identity is how they come to disagree, and the disagreement is
 * silent — a diff that matches the wrong row produces a confident wrong answer.
 *
 * ## Why this is its own module with no imports beyond a pure one
 *
 * This file is deliberately dependency-free apart from `urlIdentity`, which is
 * itself pure. That is not tidiness — it is load-bearing, and the reason is a
 * failure this repository has now hit twice in two shapes.
 *
 * `observationKey` used to live beside `loadDomainsForTargets`, which imports
 * `@/db`. **A module's imports are its imports**, so when `alertDecision` started
 * using the key it also pulled in `@/db`, and `alertDecision.test.ts` — which
 * exercises the decision layer with hand-built observations and **no database at
 * all** — failed to load in vitest's `node` environment with
 * `Cannot find package 'cloudflare:workers'`. A pure function's unit test broken
 * by an unrelated import three declarations down the file.
 *
 * So the halves are split by *what they require*, not by line count: the key needs
 * a string, the domain lookup needs a connection. **A shared helper's cost is paid
 * by everyone who imports it**, and that cost is the module's whole dependency
 * graph.
 *
 * A `null` domain stays distinguishable in the key rather than collapsing to a
 * placeholder: two observations with no domain genuinely cannot be attributed, and
 * stringifying them alike would recreate the collision for exactly the rows that
 * cannot be resolved.
 */
export function observationKey(input: {
  domain: string | null;
  platform: string;
  prompt: string;
}): string {
  const normalised = normaliseUrlForJoin(input.prompt) ?? input.prompt.trim();
  return `${input.domain ?? ""}|${input.platform}|${normalised}`;
}
