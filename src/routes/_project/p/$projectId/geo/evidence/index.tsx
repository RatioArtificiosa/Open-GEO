import { createFileRoute, Link } from "@tanstack/react-router";
import { EvidenceDrawerIndex } from "@/client/features/geo/EvidenceDrawer";

// Access is handled once by the `p/$projectId` layout; `listGeoEvidencedRuns`
// scopes by the authorized project and takes no snapshot id at all, so there is
// nothing here that could reach another organisation's rows.
export const Route = createFileRoute("/_project/p/$projectId/geo/evidence/")({
  component: EvidenceIndexRoute,
});

function EvidenceIndexRoute() {
  const { projectId } = Route.useParams();
  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-xl font-semibold">Run evidence</h1>
        <p className="text-sm text-base-content/70">
          Every number on this page is a model of something we observed. This is
          the recorded call behind each run, and what is missing from it.
        </p>
      </div>
      <EvidenceDrawerIndex projectId={projectId} />
      <p className="text-sm">
        <Link to="/p/$projectId/geo" params={{ projectId }} className="link">
          Back to visibility
        </Link>
      </p>
    </div>
  );
}
