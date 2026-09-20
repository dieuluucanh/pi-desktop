/**
 * Project inspection (plan step 10).
 *
 * The project header needs facts that only the host can answer: whether the
 * folder ships trust-requiring resources (an SDK question), its git branch, the
 * `.pi/` layout and Pi's session directory. Everything the filesystem or `git`
 * touches goes through `ProjectIo`, so this module stays pure and testable.
 *
 * `.pi/` summary note: the plan names `files.list` as the source. That handler
 * lives on a *session* host rooted at its own cwd, so a project with no open
 * session could not be inspected; this module instead probes the few paths the
 * header shows, through the same injected-port discipline.
 */

import {
  encodeSessionDirName,
  projectNameOf,
  type PiProjectResources,
  type ProjectInspection,
} from "../shared/projects";
import type { ProjectTrust } from "./project-trust";

export interface ProjectIo {
  /** `"file"`, `"directory"` or null when the path does not exist. */
  pathKind(target: string): Promise<"file" | "directory" | null>;
  /** Runs `git` in `root` and returns stdout, or null when the command fails. */
  runGit(root: string, args: readonly string[]): Promise<string | null>;
}

export interface ProjectInspectDeps {
  io: ProjectIo;
  /** The Pi profile directory (`~/.pi/agent`), for the session-dir indicator. */
  agentDir: string;
  trust: ProjectTrust;
  /** Platform-correct path join; defaults to `/`-joining (valid for path probes). */
  joinPath?: (...parts: string[]) => string;
}

const defaultJoin = (...parts: string[]): string => parts.join("/");

/** Probes `<cwd>/.pi/…` and the root context file, one path at a time. */
async function collectResources(
  cwd: string,
  deps: ProjectInspectDeps,
  join: (...parts: string[]) => string,
): Promise<PiProjectResources> {
  const kindAt = (relative: string): Promise<"file" | "directory" | null> =>
    deps.io.pathKind(join(cwd, relative));

  const [settings, agentsMdRoot, agentsMdPi, extensions, skills, prompts, themes, packages] =
    await Promise.all([
      kindAt(".pi/settings.json"),
      kindAt("AGENTS.md"),
      kindAt(".pi/AGENTS.md"),
      kindAt(".pi/extensions"),
      kindAt(".pi/skills"),
      kindAt(".pi/prompts"),
      kindAt(".pi/themes"),
      kindAt(".pi/npm"),
    ]);

  return {
    settings: settings === "file",
    agentsMd: agentsMdRoot === "file" || agentsMdPi === "file",
    extensions: extensions === "directory",
    skills: skills === "directory",
    prompts: prompts === "directory",
    themes: themes === "directory",
    packages: packages === "directory",
  };
}

export async function inspectProject(
  cwd: string,
  deps: ProjectInspectDeps,
): Promise<ProjectInspection> {
  const join = deps.joinPath ?? defaultJoin;
  const kind = await deps.io.pathKind(cwd);
  const isDirectory = kind === "directory";

  let gitBranch: string | null = null;
  if (isDirectory) {
    // A detached HEAD reports "HEAD"; anything else is the branch name.
    const output = await deps.io.runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const trimmed = output?.trim() ?? "";
    gitBranch = trimmed.length > 0 ? trimmed : null;
  }

  return {
    cwd,
    name: projectNameOf(cwd),
    exists: kind !== null,
    isDirectory,
    gitBranch,
    resources: isDirectory
      ? await collectResources(cwd, deps, join)
      : {
          settings: false,
          agentsMd: false,
          extensions: false,
          skills: false,
          prompts: false,
          themes: false,
          packages: false,
        },
    sessionDir: join(deps.agentDir, "sessions", encodeSessionDirName(cwd)),
    trust: deps.trust.status(cwd),
  };
}
