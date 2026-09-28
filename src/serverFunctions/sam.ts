import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import {
  requireAuthenticatedContext,
  requireProjectContext,
} from "@/serverFunctions/middleware";
import { AppError } from "@/server/lib/errors";
import { captureServerEvent } from "@/server/lib/posthog";
import { SamSessionRepository } from "@/server/features/sam/SamSessionRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";

// The ensure-user middleware authorizes `projectId` against the caller's org
// (ADR 0001); requireProjectContext exposes the verified project.
const projectScopedSchema = z.object({ projectId: z.string().min(1) });

// Lists the SAM chat sessions for a project (newest first) for the side-panel.
export const listSamSessions = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    return SamSessionRepository.listSessionsForProject(
      context.projectId,
      context.userId,
    );
  });

// Creates a new SAM chat session and returns its id; the client then opens a DO
// connection keyed by that id.
export const createSamSession = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    const session = await SamSessionRepository.createSession({
      projectId: context.projectId,
      userId: context.userId,
    });
    if (!session) {
      throw new AppError("INTERNAL_ERROR", "Failed to create chat session");
    }
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "sam:session_create",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId, session_id: session.id },
      }),
    );
    return { id: session.id };
  });

const archiveSchema = z.object({ sessionId: z.string().min(1) });

// Archives a SAM chat session: it disappears from the list and can no longer
// be opened, but the registry row and the DO's transcript are kept so a future
// unarchive can restore it. There is no unarchive UI yet.
export const archiveSamSession = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(archiveSchema)
  .handler(async ({ data, context }) => {
    // Authorize against the session's project (the canonical project-access
    // path), not the caller's org directly.
    const session = await SamSessionRepository.getActiveSession(
      data.sessionId,
      context.userId,
    );
    const project = session
      ? await ProjectRepository.getProjectForOrganization(
          session.projectId,
          context.organizationId,
        )
      : null;
    if (!session || !project) {
      throw new AppError("NOT_FOUND", "Chat session not found");
    }
    await SamSessionRepository.archiveSession(data.sessionId);
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "sam:session_archive",
        organizationId: context.organizationId,
        properties: { project_id: project.id, session_id: session.id },
      }),
    );
    return { ok: true };
  });
