import { createFileRoute } from "@tanstack/react-router";
import { TrendsCenterPage } from "@/client/features/trends/TrendsCenterPage";

export const Route = createFileRoute("/_project/p/$projectId/trends")({
  component: TrendsCenterRoute,
});

function TrendsCenterRoute() {
  const { projectId } = Route.useParams();
  return <TrendsCenterPage projectId={projectId} />;
}
