import { z } from "zod";

const ERROR_CODES = [
  "UNAUTHENTICATED",
  "AUTH_CONFIG_MISSING",
  "PAYMENT_REQUIRED",
  "INSUFFICIENT_CREDITS",
  "FORBIDDEN",
  "NOT_FOUND",
  "AUDIT_CAPACITY_REACHED",
  "AUDIT_PAGE_LIMIT_EXCEEDED",
  "AUDIT_ALREADY_RUNNING",
  "VALIDATION_ERROR",
  "CRAWL_TARGET_BLOCKED",
  "BACKLINKS_BILLING_ISSUE",
  "AI_SEARCH_BILLING_ISSUE",
  // One code per integration rather than one per condition, which is why this file
  // already carries two codes with the same user-facing sentence: the code says
  // *which* vendor family refused, and the copy says the same thing to the reader
  // either way. Added with the Labs search-intent client, the first Labs caller that
  // classifies billing failures.
  "LABS_BILLING_ISSUE",
  "DATAFORSEO_AUTH_FAILED",
  // CL-052's two controls, checked on the request path before the vendor is
  // called. Both are a *platform* decision rather than a funds state: the
  // balance says what an org has, the cap says what the platform allows, and the
  // kill switch says the platform has stopped everything. Each has its own code
  // so the dashboard can tell "this org refused itself" from "we closed this
  // org" — the second one is an incident.
  "BILLING_MONTHLY_CAP_EXCEEDED",
  "BILLING_CALLS_CLOSED",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "CONFLICT",
  "INTERNAL_ERROR",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

const NON_REPORTABLE_ERROR_CODES = new Set<ErrorCode>([
  "UNAUTHENTICATED",
  // External throttling (Google Analytics quota, Autumn, DataForSEO): expected
  // and transient, and nothing in the app can act on it.
  "RATE_LIMITED",
  "NOT_FOUND",
  "PAYMENT_REQUIRED",
  "INSUFFICIENT_CREDITS",
  "VALIDATION_ERROR",
  "AUDIT_CAPACITY_REACHED",
  "AUDIT_PAGE_LIMIT_EXCEEDED",
  "AUDIT_ALREADY_RUNNING",
  // CL-052's controls: the org refused itself (a cap it can see and ask about),
  // or the platform closed it (an incident the operator already knows about).
  // Neither is a defect to report, so neither is captured.
  "BILLING_MONTHLY_CAP_EXCEEDED",
  "BILLING_CALLS_CLOSED",
  // An external provider (DataForSEO) failing on its own side. Nothing in the
  // app to fix, and it drowned real exceptions. Note the error handlers only
  // log what they capture, so every throw site warns on its own line to keep
  // the failure rate visible in Workers Observability.
  "UPSTREAM_UNAVAILABLE",
]);

export function isErrorCode(value: string): value is ErrorCode {
  return errorCodeSchema.safeParse(value).success;
}

export function shouldCaptureAppErrorCode(
  code: ErrorCode | null | undefined,
): boolean {
  return code == null || !NON_REPORTABLE_ERROR_CODES.has(code);
}
