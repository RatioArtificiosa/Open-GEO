import {
  archiveProject,
  createProject,
  getProjectForOrganization,
  getProjectWithOrganization,
  listArchivedProjects,
  listProjects,
  listProjectsEnsuringOne,
  restoreProject,
  setProjectWebsite,
  updateProject,
} from "@/server/features/projects/services/projects";

export const ProjectService = {
  listProjects,
  listProjectsEnsuringOne,
  createProject,
  updateProject,
  setProjectWebsite,
  archiveProject,
  restoreProject,
  listArchivedProjects,
  getProjectForOrganization,
  getProjectWithOrganization,
} as const;
