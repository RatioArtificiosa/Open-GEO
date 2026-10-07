import { z } from "zod";

/** The Trends Center's one paid call. One request bills the same at one keyword or five. */
export const getSearchTrendsSchema = z.object({
  projectId: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1).max(5),
  /** Which index to read. The two vendors have different vocabularies for `type`. */
  source: z.enum(["dataforseo", "google"]).optional(),
  type: z
    .enum(["web", "news", "ecommerce", "youtube", "images", "froogle"])
    .optional(),
  timeRange: z
    .enum([
      "past_4_hours",
      "past_day",
      "past_7_days",
      "past_30_days",
      "past_90_days",
      "past_12_months",
      "past_5_years",
      "past_hour",
      "2004_present",
      "2008_present",
    ])
    .optional(),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
