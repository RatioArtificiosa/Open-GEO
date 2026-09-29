import { createFileRoute } from "@tanstack/react-router";
import { GeoPage } from "@/client/features/geo/GeoPage";

// Access is handled once by the `p/$projectId` layout for the whole subtree, and
// real authorization is enforced on every data call. Adding a per-page guard here
// would duplicate that and fight the redirect-only design the layout documents.
export const Route = createFileRoute("/_project/p/$projectId/geo")({
  component: GeoRoute,
});

function GeoRoute() {
  const { projectId } = Route.useParams();
  return <GeoPage projectId={projectId} />;
}
