import { z } from "zod";

export const dashboardProjectInputSchema = z.object({
  projectId: z.string().min(1),
});

export const dashboardSetupStepSchema = z.enum([
  "domain",
  "project",
  "competitor",
  "mcp",
  "gsc",
  "team",
]);
export type DashboardSetupStep = z.infer<typeof dashboardSetupStepSchema>;
export const dashboardStepDismissalSchema = dashboardProjectInputSchema.extend({
  step: dashboardSetupStepSchema,
  dismissed: z.boolean(),
});
