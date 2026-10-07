import { createFileRoute } from "@tanstack/react-router";
import { MarketMapPage } from "@/client/features/market/MarketMapPage";

export const Route = createFileRoute("/_project/p/$projectId/market")({
  component: MarketMapRoute,
});

function MarketMapRoute() {
  const { projectId } = Route.useParams();
  return <MarketMapPage projectId={projectId} />;
}
