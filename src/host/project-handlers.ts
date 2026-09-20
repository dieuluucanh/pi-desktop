/**
 * `project.*` handlers (plan step 10).
 *
 * The control host owns these because trust is an SDK decision and the `.pi/`
 * layout belongs to Pi. `src/host/index.ts` wires the real adapters; a host
 * without them answers `not_implemented` instead of pretending, exactly like
 * `files.list` and `providers.*`.
 */

import type { HostMethod } from "../shared/host-protocol";
import {
  isTrustAnswer,
  type ProjectInspection,
  type ProjectTrustStatus,
  type TrustAnswer,
} from "../shared/projects";
import type { ProjectTrust } from "./project-trust";
import type { HostHandler } from "./service";

export const PROJECT_METHODS = [
  "project.inspect",
  "project.trust",
] as const satisfies readonly HostMethod[];

export interface ProjectHandlerDeps {
  /** Inspects one project folder; absent in a host without a project adapter. */
  inspectProject?(cwd: string): Promise<ProjectInspection>;
  /** Reads and answers trust for a folder; absent when trust is unavailable. */
  trust?: ProjectTrust;
}

export class ProjectError extends Error {
  readonly code: string;

  constructor(message: string, code = "bad_request") {
    super(message);
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function requireCwd(params: unknown): string {
  const cwd = record(params).cwd;
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new ProjectError("project.* requires a cwd");
  }
  return cwd;
}

export function createProjectHandlers(deps: ProjectHandlerDeps): {
  handlers(): Partial<Record<HostMethod, HostHandler>>;
} {
  return {
    handlers: () => ({
      "project.inspect": async (params) => {
        const cwd = requireCwd(params);
        if (!deps.inspectProject) {
          throw new ProjectError(
            "project.inspect is not available in this host; no project adapter is configured",
            "not_implemented",
          );
        }
        return deps.inspectProject(cwd);
      },

      "project.trust": async (params) => {
        const cwd = requireCwd(params);
        const rawAnswer = record(params).answer;
        if (rawAnswer !== undefined && !isTrustAnswer(rawAnswer)) {
          throw new ProjectError('answer must be "trust", "never" or "session"');
        }
        if (!deps.trust) {
          throw new ProjectError(
            "project.trust is not available in this host; no trust store is configured",
            "not_implemented",
          );
        }
        return rawAnswer
          ? deps.trust.answer(cwd, rawAnswer as TrustAnswer)
          : (deps.trust.status(cwd) as ProjectTrustStatus);
      },
    }),
  };
}
