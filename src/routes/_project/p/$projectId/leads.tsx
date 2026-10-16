import { createFileRoute } from "@tanstack/react-router";
import { LeadsPage } from "@/client/features/leads/LeadsPage";

export const Route = createFileRoute("/_project/p/$projectId/leads")({
  component: LeadsRoute,
});

function LeadsRoute() {
  const { projectId } = Route.useParams();
  return <LeadsPage projectId={projectId} />;
}
