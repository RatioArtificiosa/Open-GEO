import { queryOptions } from "@tanstack/react-query";
import { getGscConnection } from "@/serverFunctions/gsc";
import { getGa4Connection } from "@/serverFunctions/ga4";

export const gscConnectionOptions = (projectId: string) =>
  queryOptions({
    queryKey: ["gscConnection", projectId],
    queryFn: () => getGscConnection({ data: { projectId } }),
  });

export const ga4ConnectionOptions = (projectId: string) =>
  queryOptions({
    queryKey: ["ga4Connection", projectId],
    queryFn: () => getGa4Connection({ data: { projectId } }),
  });
