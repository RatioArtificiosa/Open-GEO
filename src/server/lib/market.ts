import { AppError } from "@/server/lib/errors";
import {
  DEFAULT_LOCATION_CODE,
  getKeywordDataProvider,
  getLanguageOptions,
  isLanguageServedForLocation,
  resolveLabsMarket,
} from "@/shared/keyword-locations";

/**
 * Guards Labs-backed tools (domain analytics) against locations we serve
 * from Google Ads keyword data only.
 */
export function assertLabsLocationCode(locationCode: number | undefined) {
  if (locationCode != null && getKeywordDataProvider(locationCode) !== "labs") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Domain analytics is not available for this country. Keyword research and rank tracking work; domain-level data is limited to DataForSEO Labs locations.",
    );
  }
}

/**
 * Guards Labs-backed callers against a language DataForSEO doesn't serve for
 * the chosen location. A mismatched pair (e.g. language_code="ru" for the
 * United States) is otherwise rejected as an opaque *charged* "Invalid Field:
 * 'language_code'." task failure, so validate the pair first (cost 0).
 */
export function assertLanguageForLocation(
  locationCode: number | undefined,
  languageCode: string | undefined,
) {
  if (languageCode == null) return;
  const resolvedLocation = locationCode ?? DEFAULT_LOCATION_CODE;
  if (isLanguageServedForLocation(resolvedLocation, languageCode)) return;
  throw new AppError(
    "VALIDATION_ERROR",
    `Language '${languageCode}' is not available for this location. Available: ${getLanguageOptions(
      resolvedLocation,
    )
      .map((option) => option.code)
      .join(", ")}.`,
  );
}

/**
 * The Labs location and language a call should use.
 *
 * Shared here so a second Labs tool does not grow its own copy of the policy: explicit fields win,
 * and an omitted pair inherits the project's market through `resolveLabsMarket`, which keeps
 * these tools off an Ads-served market. Iceland, for instance, is served from Google Ads data, so
 * inheriting it would send a request the vendor rejects **after charging for it**. Both assertions
 * run before the paid call.
 *
 * The legacy `market: { country: "US" }` selector that `dataforseo-research-tools.ts` also accepts
 * is deliberately absent: it exists for tools that shipped with it, and a new tool has no
 * back-compatibility to preserve.
 */
export function resolveLabsMarketSelector(
  selector: { locationCode?: number; languageCode?: string },
  project: { locationCode: number; languageCode: string },
): { locationCode: number; languageCode: string } {
  const resolved =
    selector.locationCode != null || selector.languageCode != null
      ? resolveLabsMarket(
          {
            locationCode: selector.locationCode,
            languageCode: selector.languageCode,
          },
          project,
        )
      : resolveLabsMarket({}, project);

  assertLabsLocationCode(resolved.locationCode);
  assertLanguageForLocation(resolved.locationCode, resolved.languageCode);
  return resolved;
}
