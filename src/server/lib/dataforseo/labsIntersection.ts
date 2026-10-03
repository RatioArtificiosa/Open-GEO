/**
 * The two intersection endpoints, split out because `labs.ts` passed `max-lines`.
 *
 * ## Why these two are alone
 *
 * **They are the only Labs endpoints whose responses persist a formula version.** Every row
 * here carries an `etv`, which means its numbers are comparable only within one ETV model —
 * and DataForSEO switches on 2026-11-01. So the call must report *which* model it asked for,
 * and that has to be the same resolution the request body carried.
 *
 * **`etvFields` is imported rather than copied** for exactly that reason: a second
 * implementation of the flag is a second thing to forget to keep in step, and the failure is
 * silent — a stored ETV labelled with the wrong model, in a table that looks perfectly valid.
 *
 * ## The assertion that matters
 *
 * `use_new_etv` in the request body **is** `etv.useNewEtv` on the response. Send one and
 * record the other and every number in the table is wrong while every test passes, which is
 * the worst shape a bug can have.
 */
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
  type DataforseoItemsTask,
} from "@/server/lib/dataforseo/envelope";
import { etvFields } from "./labs";
import type {
  EtvBearingLabsEndpoint,
  EtvProvenance,
} from "@/shared/etv-versioning";

/**
 * One row of a domain- or page-intersection result.
 *
 * **Typed honestly, not validated.** `intersection_info` is the interesting field and it is
 * untyped here — see the note above the Labs payload types: these are claims about the
 * payload, and a field that *must* hold gets a Zod schema. What must hold is the presence of
 * a `domain` and an `etv`, and both are checked where they would be stored rather than here,
 * so an absent ETV is caught at the boundary that persists it.
 */
export interface IntersectionItem {
  domain?: string | null;
  /** Estimated traffic volume — **an ETV, and therefore formula-versioned.** */
  etv?: number | null;
  /** How many of the compared domains this domain outranks on. */
  intersection_info?: {
    intersecting_domains?: number | null;
    intersecting_keywords?: number | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

/** Shared request shape — both intersection endpoints take exactly these parameters. */
export type DomainIntersectionRequest = {
  /** The domains we own or track. The vendor accepts up to ten per call. */
  domains: string[];
  /** The competitor domains to intersect them against. */
  competitors: string[];
  locationCode: number;
  languageCode: string;
  /** When true, a subdomain of a listed domain counts as the same domain. */
  includeSubdomains?: boolean;
  limit: number;
  offset?: number;
  /** Injected so the ETV mode is reproducible in a test. */
  now?: Date;
};

/**
 * The body both intersection calls send, with the ETV flag folded in.
 *
 * **The flag is spread in by `etvFields` rather than passed as an argument**, so the
 * `use_new_etv` on the response is literally the flag sent — the guarantee `etvFields`
 * documents. A caller that resolved the mode itself could resolve it twice and record a
 * version the call did not use, which is a silent lie in the archive rather than a visible
 * error. **That is the whole reason these two go through the helper.**
 */
function intersectionBody(
  input: DomainIntersectionRequest,
  endpoint: EtvBearingLabsEndpoint,
): Record<string, unknown> {
  const etv = etvFields(endpoint, input.now);
  return {
    domains: input.domains,
    competitors: input.competitors,
    location_code: input.locationCode,
    language_code: input.languageCode,
    include_subdomains: input.includeSubdomains,
    limit: input.limit,
    offset: input.offset,
    use_new_etv: etv.use_new_etv,
  };
}

export async function fetchDomainIntersection(
  input: DomainIntersectionRequest,
): Promise<DataforseoApiResponse<IntersectionItem[]> & { etv: EtvProvenance }> {
  const response = await dataforseoPost<DataforseoItemsTask<IntersectionItem>>(
    "/v3/dataforseo_labs/google/domain_intersection/live",
    [intersectionBody(input, "domain_intersection")],
  );
  const task = assertOk(response);
  // **Resolved once and reused** — the first version called `etvFields` four times to build
  // three fields, which means four `new Date()` reads and, worse, four chances to record a
  // version the request did not use.
  const etv = etvFields("domain_intersection", input.now);
  return {
    data: task.result?.[0]?.items ?? [],
    billing: buildTaskBilling(task),
    // **The provenance the caller must persist beside the value.** A stored ETV without its
    // formula version becomes unreadable after the 2026-11-01 cutover, and the task envelope
    // does not carry it, so this is the only place it can be captured.
    etv: {
      formulaVersion: etv.formulaVersion,
      useNewEtv: etv.useNewEtv,
      requestedAt: etv.requestedAt,
    },
  };
}

export async function fetchPageIntersection(
  input: DomainIntersectionRequest & {
    /** Pages of our own site, one path or full URL each. */
    pages: string[];
  },
): Promise<DataforseoApiResponse<IntersectionItem[]> & { etv: EtvProvenance }> {
  const response = await dataforseoPost<DataforseoItemsTask<IntersectionItem>>(
    "/v3/dataforseo_labs/google/page_intersection/live",
    [
      {
        ...intersectionBody(input, "page_intersection"),
        pages: input.pages,
      },
    ],
  );
  const task = assertOk(response);
  const etv = etvFields("page_intersection", input.now);
  return {
    data: task.result?.[0]?.items ?? [],
    billing: buildTaskBilling(task),
    etv: {
      formulaVersion: etv.formulaVersion,
      useNewEtv: etv.useNewEtv,
      requestedAt: etv.requestedAt,
    },
  };
}
