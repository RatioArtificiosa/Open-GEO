import { createFileRoute, notFound } from "@tanstack/react-router";
import { BillingAdminSettings } from "@/client/features/settings/BillingAdminSettings";
import { isHostedClientAuthMode } from "@/lib/auth-mode";

export const Route = createFileRoute("/_app/settings/platform")({
  // The markup is a hosted concern. A self-hosted deployment pays the vendor
  // directly and passes the cost through unchanged, so there is no dial to
  // turn there and the page would only imply that there is one.
  beforeLoad: () => {
    if (!isHostedClientAuthMode()) {
      throw notFound();
    }
  },
  component: BillingAdminSettings,
});
