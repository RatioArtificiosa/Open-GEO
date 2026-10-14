import * as React from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Menu } from "lucide-react";
import {
  MissingSeoSetupModal,
  MobileSidebarDrawer,
  SeoApiStatusBanners,
} from "@/client/layout/AppShellParts";
import { GscReEngagementModal } from "@/client/features/gsc/GscReEngagementModal";
import { Sidebar } from "@/client/components/Sidebar";
import { BILLING_ROUTE } from "@/shared/billing";
import { getSeoApiKeyStatus } from "@/serverFunctions/config";
import { getProjects } from "@/serverFunctions/projects";
import { getLastProjectId } from "@/client/lib/active-project";

const DATAFORSEO_HELP_PATH = "/help/dataforseo-api-key";

export function AuthenticatedAppLayout({
  children,
  projectId,
  banner,
}: {
  children: React.ReactNode;
  projectId?: string;
  banner?: React.ReactNode;
}) {
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const setupModalRef = React.useRef<HTMLDivElement | null>(null);
  const [showMissingSeoApiKeyModal, setShowMissingSeoApiKeyModal] =
    React.useState(false);
  /**
   * Whether the user has dismissed the setup modal in **this session**.
   *
   * Separate from `showMissingSeoApiKeyModal` on purpose. `show…` says the dialog is
   * open right now; this says the user has answered the question. Keeping them apart
   * is what lets the effect open the modal exactly once rather than once per
   * refetch — see the effect below for the debugging that distinction cost.
   *
   * Deliberately **not persisted**: a dismissed reminder should not silently vanish
   * for good, or a user who dismisses it on Monday never learns their key is still
   * missing. A reload re-arms it, which is the right behaviour for a nudge about a
   * missing credential and the wrong one for a dismissal the user expects to stick.
   */
  const [dismissedSetupModal, setDismissedSetupModal] = React.useState(false);
  // On non-project pages (e.g. /settings) there's no projectId in the URL, so
  // derive one for the nav/switcher: prefer the last-visited project, else the
  // most recent. The whole app tree is client-only (see root ClientOnly), so we
  // can read localStorage synchronously during the first render — this lets the
  // sidebar show the full project nav on the very first paint instead of briefly
  // flashing only the always-visible Connect group while projects load.
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => getProjects(),
    enabled: !projectId,
  });
  const [rememberedProjectId] = React.useState<string | null>(() =>
    getLastProjectId(),
  );
  const fallbackProjects = projectsQuery.data ?? [];
  const fallbackProjectId =
    fallbackProjects.find((project) => project.id === rememberedProjectId)
      ?.id ??
    fallbackProjects[0]?.id ??
    null;
  // Once the projects list loads, fallbackProjectId is the validated choice
  // (remembered-if-valid, else most recent). Before it loads, fall back to the
  // remembered id so the project nav renders immediately; a stale id here only
  // builds links that self-correct via the route guard once data arrives.
  const sidebarProjectId =
    projectId ?? fallbackProjectId ?? rememberedProjectId;
  const shouldCheckSeoApiKeyStatus = location.pathname !== BILLING_ROUTE;
  const seoApiKeyStatusQuery = useQuery({
    queryKey: ["seoApiKeyStatus"],
    queryFn: () => getSeoApiKeyStatus(),
    enabled: shouldCheckSeoApiKeyStatus,
  });
  const isSeoApiKeyConfigured = shouldCheckSeoApiKeyStatus
    ? (seoApiKeyStatusQuery.data?.configured ?? null)
    : null;
  const seoApiKeyStatusError =
    shouldCheckSeoApiKeyStatus && seoApiKeyStatusQuery.isError;

  React.useEffect(() => {
    if (!shouldCheckSeoApiKeyStatus) {
      setShowMissingSeoApiKeyModal(false);
      return;
    }

    if (seoApiKeyStatusQuery.isError) {
      setShowMissingSeoApiKeyModal(false);
      return;
    }

    if (!seoApiKeyStatusQuery.isSuccess) return;

    /**
     * **Only open it, and only once per session.**
     *
     * The previous line unconditionally wrote `!configured`, which means the value a
     * user dismissed was overwritten by the next thing that changed this effect's
     * inputs — and those inputs include `location.pathname` and
     * `seoApiKeyStatusQuery.data`, the latter a fresh object identity on every
     * refetch. So dismissing the modal did nothing: it came back on the next
     * navigation or the next status poll.
     *
     * Guarding on `!showMissingSeoApiKeyModal` alone is **not** enough, and the
     * reason is worth writing down because it cost a debugging cycle: state is
     * closed by `onClose`, so the guard should have held — but the effect's *first*
     * run and its second run are indistinguishable from inside it. React Query
     * resolves the query, the effect opens the modal, the user dismisses it, and the
     * **refetch** re-runs the effect on new data. Each of those is a legitimate
     * trigger for "should the modal be shown?", and only the first one should win.
     *
     * So the decision is recorded in state rather than inferred: `true` means "shown
     * at least once", `false` means "not yet", and `onClose` is what marks a
     * dismissal as final. The modal still appears for a user who has never dismissed
     * it — that is its job — but a dismissal inside this session is durable.
     *
     * The error branch above is unchanged: it *closes*, because an unknown status is
     * not evidence of a missing key, and asserting one would be the guess
     * `getAuthMode` already refuses to make.
     */
    if (!seoApiKeyStatusQuery.data.configured && !dismissedSetupModal) {
      setShowMissingSeoApiKeyModal(true);
    }
  }, [
    location.pathname,
    seoApiKeyStatusQuery.data,
    seoApiKeyStatusQuery.isError,
    seoApiKeyStatusQuery.isSuccess,
    shouldCheckSeoApiKeyStatus,
    // **`dismissedSetupModal`, and omitting it was the last version of this bug.**
    // The effect closes over the flag, so without it in the array a refetch re-runs
    // the effect with the closure captured at the *previous* render — where the flag
    // was still `false` — and the guard passes even though the user dismissed it.
    // The exact stale-closure class `exhaustive-deps` exists to catch, which this
    // file did not have enabled because the array was written by hand.
    dismissedSetupModal,
  ]);

  const shouldShowMissingSeoApiKeyModal =
    showMissingSeoApiKeyModal && location.pathname !== DATAFORSEO_HELP_PATH;

  const shouldShowSeoApiWarning =
    !seoApiKeyStatusError &&
    isSeoApiKeyConfigured === false &&
    !shouldShowMissingSeoApiKeyModal;

  React.useEffect(() => {
    if (!shouldShowMissingSeoApiKeyModal) return;

    setupModalRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // **Both flags, because Escape is a dismissal too.** Setting only the
        // "open" flag closed the dialog and left the "answered" flag untouched, so
        // the very next refetch re-opened it — the same bug as the button's path,
        // one line lower.
        setShowMissingSeoApiKeyModal(false);
        setDismissedSetupModal(true);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [shouldShowMissingSeoApiKeyModal]);

  return (
    <div className="flex h-[100dvh] bg-base-200">
      <div className="hidden shrink-0 md:block">
        <Sidebar projectId={sidebarProjectId} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <MobileTopBar
          drawerOpen={drawerOpen}
          onOpenDrawer={() => setDrawerOpen(true)}
        />

        {/* PostHog-style cutout: the main content sits on a raised panel with a
            thin strip of the sidebar background above it and a hairline border. */}
        <div className="flex min-h-0 flex-1 flex-col md:pt-2">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-base-100 md:rounded-tl-lg md:border-l md:border-t md:border-base-300">
            <SeoApiStatusBanners
              shouldShowSeoApiWarning={shouldShowSeoApiWarning}
              seoApiKeyStatusError={seoApiKeyStatusError}
            />

            {banner}

            <div className="min-h-0 flex-1 overflow-auto">{children}</div>
          </div>
        </div>
      </div>

      <MobileSidebarDrawer
        open={drawerOpen}
        projectId={sidebarProjectId}
        onClose={() => setDrawerOpen(false)}
      />

      <MissingSeoSetupModal
        ref={setupModalRef}
        isOpen={shouldShowMissingSeoApiKeyModal}
        onClose={() => {
          setShowMissingSeoApiKeyModal(false);
          // **Mark the dismissal, so no later refetch re-opens it.** Without this the
          // guard in the effect has nothing to check, and the modal returns on the
          // next status poll — which is exactly what it did before.
          setDismissedSetupModal(true);
        }}
      />

      <GscReEngagementModal
        projectId={sidebarProjectId}
        suppressed={shouldShowMissingSeoApiKeyModal}
      />
    </div>
  );
}

function MobileTopBar({
  drawerOpen,
  onOpenDrawer,
}: {
  drawerOpen: boolean;
  onOpenDrawer: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-base-300 bg-base-100 px-2 py-1.5 md:hidden">
      <button
        type="button"
        className="btn btn-square btn-ghost btn-sm"
        aria-label="Toggle sidebar"
        aria-expanded={drawerOpen}
        onClick={onOpenDrawer}
      >
        <Menu className="h-5 w-5" />
      </button>
      <Link to="/" className="ml-1 font-semibold text-base-content">
        OpenGeo
      </Link>
    </div>
  );
}
