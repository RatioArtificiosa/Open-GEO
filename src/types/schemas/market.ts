import { z } from "zod";

/**
 * The Market Map's one paid call.
 *
 * One page at a time and a bounded number of categories, because this is a Labs request and the
 * screen prices it before it runs.
 */
export const getDomainCategoriesSchema = z.object({
  projectId: z.string().min(1),
  target: z.string().min(1),
  limit: z.number().int().min(1).max(1000).optional(),
  includeClickstreamData: z.boolean().optional(),
});
