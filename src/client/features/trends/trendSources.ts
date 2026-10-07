/**
 * The two trend indexes, as the page needs to describe them.
 *
 * ## Why this is a module rather than three arrays inside a component
 *
 * The two vendors do not accept the same vocabulary, and that has a consequence a user will hit:
 * switching source while a Google-only window such as `2004_present` is selected would send a
 * value the DataForSEO endpoint rejects. **Coercing on switch is a correctness rule**, not a UI
 * convenience, so it lives here where it can be tested.
 *
 * The prices differ by roughly nine times, which is the other reason the source is a choice rather
 * than a default: `dfsTrends.explore` is $0.0012 a request and `googleTrends.live` is $0.011.
 */
import { DFS_KEYWORDS } from "@/shared/dataforseo-pricing";

export type TrendSource = "dataforseo" | "google";

/** Every index type either vendor accepts; each source offers its own subset. */
export type TrendType =
  | "web"
  | "news"
  | "ecommerce"
  | "youtube"
  | "images"
  | "froogle";

/** Every preset window either vendor accepts; Google serves the last three. */
export type TrendWindowValue =
  | "past_7_days"
  | "past_30_days"
  | "past_90_days"
  | "past_12_months"
  | "past_5_years"
  | "past_hour"
  | "2004_present"
  | "2008_present";

type TrendWindowOption = {
  value: TrendWindowValue;
  label: string;
  googleOnly?: boolean;
};

/** Windows both indexes accept. */
const SHARED_WINDOWS: TrendWindowOption[] = [
  { value: "past_7_days", label: "7 days" },
  { value: "past_30_days", label: "30 days" },
  { value: "past_90_days", label: "90 days" },
  { value: "past_12_months", label: "12 months" },
  { value: "past_5_years", label: "5 years" },
];

/** Presets only Google exposes, including the two "since inception" options. */
const GOOGLE_ONLY_WINDOWS: TrendWindowOption[] = [
  { value: "past_hour", label: "last hour", googleOnly: true },
  { value: "2004_present", label: "2004 to now", googleOnly: true },
  { value: "2008_present", label: "2008 to now", googleOnly: true },
];

/**
 * The index types, which is where the vendors diverge most visibly: DataForSEO says `ecommerce`
 * and Google says `froogle` for the same idea.
 */
const TYPE_OPTIONS = {
  dataforseo: [
    { value: "web", label: "Web" },
    { value: "news", label: "News" },
    { value: "ecommerce", label: "Shopping" },
  ],
  google: [
    { value: "web", label: "Web" },
    { value: "news", label: "News" },
    { value: "youtube", label: "YouTube" },
    { value: "images", label: "Images" },
    { value: "froogle", label: "Shopping (froogle)" },
  ],
} as const satisfies Record<
  TrendSource,
  ReadonlyArray<{ value: TrendType; label: string }>
>;

export const TREND_SOURCES: Array<{
  value: TrendSource;
  label: string;
  pricePerRequest: number;
}> = [
  {
    value: "dataforseo",
    label: "DataForSEO Trends",
    pricePerRequest: DFS_KEYWORDS.dfsTrends.explore.perRequest,
  },
  {
    value: "google",
    label: "Google Trends",
    pricePerRequest: DFS_KEYWORDS.googleTrends.live.perRequest,
  },
];

export function windowsFor(source: TrendSource): TrendWindowOption[] {
  return source === "google"
    ? [...SHARED_WINDOWS, ...GOOGLE_ONLY_WINDOWS]
    : SHARED_WINDOWS;
}

export function typesFor(source: TrendSource) {
  return TYPE_OPTIONS[source];
}

export function priceFor(source: TrendSource): number {
  return (
    TREND_SOURCES.find((entry) => entry.value === source)?.pricePerRequest ?? 0
  );
}

/**
 * A window the chosen source actually accepts.
 *
 * Falls back to twelve months, which both indexes serve, rather than sending a Google-only preset
 * to DataForSEO and taking a billed rejection for a control the user only touched.
 */
export function coerceWindow(
  source: TrendSource,
  value: string,
): TrendWindowValue {
  // A lookup rather than a validated string: the match's own type is the union, so nothing has to
  // be asserted and the fallback is a value both indexes serve.
  const match = windowsFor(source).find((option) => option.value === value);
  return match?.value ?? "past_12_months";
}

/** A type the chosen source actually accepts. `froogle` and `ecommerce` are not interchangeable. */
export function coerceType(source: TrendSource, value: string): TrendType {
  const match = typesFor(source).find((option) => option.value === value);
  return match?.value ?? "web";
}
