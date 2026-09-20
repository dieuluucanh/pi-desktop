import { describe, expect, it } from "vitest";
import { inspectProject, type ProjectIo } from "../../src/host/project-inspect";
import { createProjectTrust, type TrustDecision } from "../../src/host/project-trust";

const CWD = "C:/work/app";
const AGENT_DIR = "C:/Users/me/.pi/agent";

function io(
  paths: Record<string, "file" | "directory">,
  git: string | null = null,
): ProjectIo & { gitCalls: Array<readonly string[]> } {
  const gitCalls: Array<readonly string[]> = [];
  return {
    gitCalls,
    pathKind: async (target) => paths[target] ?? null,
    runGit: async (_root, args) => {
      gitCalls.push(args);
      return git;
    },
  };
}

function trust(requiresTrust: boolean, decision: TrustDecision = null) {
  return createProjectTrust({
    store: { get: () => decision, set: () => undefined },
    requiresTrust: () => requiresTrust,
  });
}

describe("inspectProject", () => {
  it("reports the git branch, .pi resources and the session directory", async () => {
    const deps = {
      io: io(
        {
          [CWD]: "directory",
          [`${CWD}/.pi/settings.json`]: "file",
          [`${CWD}/AGENTS.md`]: "file",
          [`${CWD}/.pi/extensions`]: "directory",
          [`${CWD}/.pi/npm`]: "directory",
        },
        "feature/plan-10\n",
      ),
      agentDir: AGENT_DIR,
      trust: trust(false),
    };

    const inspection = await inspectProject(CWD, deps);

    expect(inspection).toMatchObject({
      cwd: CWD,
      name: "app",
      exists: true,
      isDirectory: true,
      gitBranch: "feature/plan-10",
      sessionDir: `${AGENT_DIR}/sessions/--C--work-app--`,
    });
    expect(inspection.resources).toEqual({
      settings: true,
      agentsMd: true,
      extensions: true,
      skills: false,
      prompts: false,
      themes: false,
      packages: true,
    });
  });

  it("accepts a .pi/AGENTS.md and treats a detached HEAD as no branch", async () => {
    const deps = {
      io: io({ [CWD]: "directory", [`${CWD}/.pi/AGENTS.md`]: "file" }, "HEAD\n"),
      agentDir: AGENT_DIR,
      trust: trust(false),
    };
    const inspection = await inspectProject(CWD, deps);
    expect(inspection.resources.agentsMd).toBe(true);
    // `--abbrev-ref HEAD` on a detached HEAD reports "HEAD", not a branch name.
    expect(inspection.gitBranch).toBe("HEAD");
  });

  it("returns a null branch when git is missing", async () => {
    const deps = {
      io: io({ [CWD]: "directory" }, null),
      agentDir: AGENT_DIR,
      trust: trust(false),
    };
    expect((await inspectProject(CWD, deps)).gitBranch).toBeNull();
  });

  it("does not probe resources or git for a missing folder", async () => {
    const projectIo = io({});
    const inspection = await inspectProject(CWD, {
      io: projectIo,
      agentDir: AGENT_DIR,
      trust: trust(false),
    });

    expect(inspection.exists).toBe(false);
    expect(inspection.isDirectory).toBe(false);
    expect(inspection.gitBranch).toBeNull();
    expect(inspection.resources.settings).toBe(false);
    expect(projectIo.gitCalls).toHaveLength(0);
  });

  it("carries the trust status the project's resources imply", async () => {
    const deps = {
      io: io({ [CWD]: "directory", [`${CWD}/.pi/settings.json`]: "file" }),
      agentDir: AGENT_DIR,
      trust: trust(true),
    };
    const inspection = await inspectProject(CWD, deps);
    expect(inspection.trust).toMatchObject({ requiresTrust: true, needsPrompt: true });
  });

  it("uses an injected path joiner so the display path matches the platform", async () => {
    const deps = {
      io: io({ [CWD]: "directory" }),
      agentDir: "C:\\Users\\me\\.pi\\agent",
      trust: trust(false),
      joinPath: (...parts: string[]) => parts.join("\\"),
    };
    const inspection = await inspectProject(CWD, deps);
    expect(inspection.sessionDir).toBe("C:\\Users\\me\\.pi\\agent\\sessions\\--C--work-app--");
  });
});
