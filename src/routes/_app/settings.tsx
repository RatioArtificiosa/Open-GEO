import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { isHostedClientAuthMode } from "@/lib/auth-mode";
import { useQuery } from "@tanstack/react-query";
import { getBillingAdminSettings } from "@/serverFunctions/billing";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsLayout,
});

// Account-level settings, tabbed like project settings. Personal = the
// signed-in user (theme, API keys, analytics); Organization = the active org
// (team). Billing keeps its own page — it's linked from paywalls all over.
function SettingsLayout() {
  // The operator tab is only shown when it would open. Asking the server keeps
  // the tab out of everyone else's settings instead of 404ing them, and a
  // deployment with no configured owner never sees it either.
  const canAdministerBilling = useCanAdministerBilling();
  const tabs = [
    { to: "/settings" as const, label: "Personal", exact: true },
    // Self-host has no memberships — the organization tab would 404.
    ...(isHostedClientAuthMode()
      ? [{ to: "/settings/organization" as const, label: "Organization" }]
      : []),
    ...(canAdministerBilling
      ? [{ to: "/settings/platform" as const, label: "Platform" }]
      : []),
  ];

  return (
    <div className="h-full overflow-auto bg-base-100">
      <div className="mx-auto w-full max-w-4xl space-y-8 p-4 py-8 pb-24 sm:p-6 md:py-12 md:pb-12">
        <div className="space-y-4">
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <div role="tablist" className="tabs tabs-border">
            {tabs.map((tab) => (
              <Link
                key={tab.to}
                role="tab"
                to={tab.to}
                activeOptions={{ exact: tab.exact ?? false }}
                className="tab"
                activeProps={{
                  className: "tab-active",
                  "aria-selected": true,
                }}
                inactiveProps={{ "aria-selected": false }}
              >
                {tab.label}
              </Link>
            ))}
          </div>
        </div>

        <Outlet />
      </div>
    </div>
  );
}

/**
 * Whether this signed-in user holds the operator role.
 *
 * A failed request — including the 403 that is the normal answer for everyone
 * else — reads as "not an operator" rather than as an error, so a non-owner
 * never sees a broken request in their settings page.
 */
function useCanAdministerBilling() {
  const { data } = useQuery({
    queryKey: ["billingAdminSettings"],
    queryFn: () => getBillingAdminSettings(),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  return data !== undefined;
}
