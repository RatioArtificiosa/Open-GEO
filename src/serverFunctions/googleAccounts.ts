import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { GoogleAccountService } from "@/server/features/google/GoogleAccountService";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";

const accountSchema = z.object({
  provider: z.enum(["gsc", "ga4"]),
  accountId: z.string().min(1),
});

export const getGoogleAccountRemovalImpact = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(accountSchema)
  .handler(({ data, context }) =>
    GoogleAccountService.getRemovalImpact({ ...data, userId: context.userId }),
  );

export const removeGoogleAccount = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(accountSchema.extend({ confirmed: z.literal(true) }))
  .handler(({ data, context }) =>
    GoogleAccountService.remove({ ...data, userId: context.userId }),
  );
