/**
 * The countries the free tools offer. Codes are DataForSEO location codes;
 * the language is the one DataForSEO expects for that market. The client only
 * ever sends a location code — the server derives the language from this list,
 * so an unknown code is rejected rather than passed through.
 */
export const TOOL_COUNTRIES = [
  { code: 2840, label: "United States", language: "en" },
  { code: 2826, label: "United Kingdom", language: "en" },
  { code: 2124, label: "Canada", language: "en" },
  { code: 2036, label: "Australia", language: "en" },
  { code: 2276, label: "Germany", language: "de" },
  { code: 2250, label: "France", language: "fr" },
  { code: 2724, label: "Spain", language: "es" },
  { code: 2356, label: "India", language: "en" },
  { code: 2528, label: "Netherlands", language: "nl" },
  { code: 2076, label: "Brazil", language: "pt" },
] as const;

export const DEFAULT_COUNTRY_CODE = 2840;

export function countryLanguage(code: number): string | null {
  return (
    TOOL_COUNTRIES.find((country) => country.code === code)?.language ?? null
  );
}

export function countryLabel(code: number): string {
  return (
    TOOL_COUNTRIES.find((country) => country.code === code)?.label ?? "Unknown"
  );
}
