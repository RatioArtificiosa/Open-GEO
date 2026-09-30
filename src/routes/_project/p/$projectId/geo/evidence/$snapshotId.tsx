import { createFileRoute } from "@tanstack/react-router";
import { EvidenceDrawer } from "@/client/features/geo/EvidenceDrawer";

// Access is handled once by the `p/$projectId` layout for the whole subtree, and
// real authorization is enforced on every data call — `getGeoEvidence` checks
// the snapshot belongs to the authorized project before it reads anything. Adding
// a per-page guard here would duplicate that and fight the redirect-only design
// the layout documents.
export const Route = createFileRoute(
  "/_project/p/$projectId/geo/evidence/$snapshotId",
)({
  component: EvidenceRoute,
});

function EvidenceRoute() {
  const { projectId, snapshotId } = Route.useParams();
  return (
    <div className="p-4">
      <EvidenceDrawer projectId={projectId} snapshotId={snapshotId} />
    </div>
  );
}
