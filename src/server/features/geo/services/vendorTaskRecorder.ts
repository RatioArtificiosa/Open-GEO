import { executeInBatches } from "@/db/runBatch";
import { geoVendorTasks } from "@/db/schema";
import { EVIDENCE_LIMITS, serialiseForEvidence } from "./vendorTaskEvidence";

/**
 * Writing the vendor-call evidence.
 *
 * The table (CL-603) is only worth anything if rows actually land in it, and the
 * one place that can guarantee it is the same seam the rate gates sit on: every
 * DataForSEO call passes through `requestDataforseo`.
 *
 * ## Recording is best-effort, and that is deliberate
 *
 * An evidence write that could fail a customer request would be worse than no
 * evidence: a monitoring feature that takes down the product it monitors is not
 * monitoring. So every write here is wrapped, a failure is logged once, and the
 * call proceeds. The consequence is stated rather than hidden — **a window of
 * evidence can be missing** — and that is a far better failure than a request
 * that fails because a table grew too large.
 *
 * ## The two truncation limits, and why there are two
 *
 * `responseBody` is capped hard, because a Lighthouse payload is multiple
 * megabytes and a D1 row has a practical ceiling. `requestBody` is capped much
 * higher, because a request we cannot reproduce is the failure CL-603 exists to
 * prevent, and requests are small by construction.
 *
 * Both truncate with an explicit marker rather than silently cutting, so a
 * re-derivation that hits the cap *knows* it is looking at a partial body. A
 * silent truncation would produce a wrong re-derivation that looks right, which
 * is the worst outcome this table could have.
 */

type VendorTaskEvidence = {
  projectId: string;
  snapshotId?: string | null;
  /** Response path segments, joined for storage. */
  path: string;
  requestBody?: unknown;
  tag?: string | null;
  vendorTaskId?: string | null;
  responseBody?: unknown;
  statusCode?: number | null;
  costUsd?: number | null;
  chargedUsd?: number | null;
  startedAt: string;
  completedAt?: string | null;
};

/**
 * Record one vendor call.
 *
 * Never throws. Returns whether the evidence was stored, so a caller that cares
 * (a nightly job reconciling spend) can log a gap rather than assume completeness.
 */
export async function recordVendorTask(
  evidence: VendorTaskEvidence,
): Promise<boolean> {
  try {
    await executeInBatches(
      [
        {
          id: crypto.randomUUID(),
          projectId: evidence.projectId,
          snapshotId: evidence.snapshotId ?? null,
          path: evidence.path,
          requestBody: serialiseForEvidence(
            evidence.requestBody,
            EVIDENCE_LIMITS.requestBody,
          ),
          tag: evidence.tag ?? null,
          vendorTaskId: evidence.vendorTaskId ?? null,
          responseBody: serialiseForEvidence(
            evidence.responseBody,
            EVIDENCE_LIMITS.responseBody,
          ),
          statusCode: evidence.statusCode ?? null,
          costUsd: evidence.costUsd ?? null,
          chargedUsd: evidence.chargedUsd ?? null,
          startedAt: evidence.startedAt,
          completedAt: evidence.completedAt ?? null,
        },
      ],
      (tx, row) => tx.insert(geoVendorTasks).values(row),
    );
    return true;
  } catch (error) {
    // `warn`, not `error`: the error handlers surface what they capture, and a
    // lost evidence row is a gap in the record rather than a product fault. It
    // still needs to be visible, though — a silent gap is the failure mode.
    console.warn("dataforseo.evidence-not-stored", {
      path: evidence.path,
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
