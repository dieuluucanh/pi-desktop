import { describe, expect, it, vi } from "vitest";
import { createControlCore, CONTROL_METHODS } from "../../src/host/control-core";
import { createProjectHandlers, ProjectError } from "../../src/host/project-handlers";
import { createProjectTrust } from "../../src/host/project-trust";
import type { ProjectInspection } from "../../src/shared/projects";

const CWD = "C:/work/app";

const INSPECTION: ProjectInspection = {
  cwd: CWD,
  name: "app",
  exists: true,
  isDirectory: true,
  gitBranch: "main",
  resources: {
    settings: true,
    agentsMd: false,
    extensions: false,
    skills: false,
    prompts: false,
    themes: false,
    packages: false,
  },
  sessionDir: "C:/profile/sessions/--C--work-app--",
  trust: {
    cwd: CWD,
    requiresTrust: true,
    decision: null,
    trusted: false,
    needsPrompt: true,
  },
};

function trustWith(requiresTrust: boolean, initial: boolean | null = null) {
  const decisions = new Map<string, boolean | null>();
  if (initial !== null) decisions.set(CWD, initial);
  return createProjectTrust({
    store: {
      get: (cwd) => decisions.get(cwd) ?? null,
      set: (cwd, decision) => {
        decisions.set(cwd, decision);
      },
    },
    requiresTrust: () => requiresTrust,
    // `createProjectTrust` writes through the store; the map above records it.
  });
}

describe("project handlers", () => {
  it("answers not_implemented when no project adapter is configured", async () => {
    const handlers = createProjectHandlers({}).handlers();
    await expect(handlers["project.inspect"]?.({ cwd: CWD }, {} as never)).rejects.toMatchObject({
      code: "not_implemented",
    });
    await expect(handlers["project.trust"]?.({ cwd: CWD }, {} as never)).rejects.toMatchObject({
      code: "not_implemented",
    });
  });

  it("rejects a missing cwd and a bad trust answer", async () => {
    const handlers = createProjectHandlers({
      inspectProject: async () => INSPECTION,
      trust: trustWith(true),
    }).handlers();

    await expect(handlers["project.inspect"]?.({}, {} as never)).rejects.toBeInstanceOf(
      ProjectError,
    );
    await expect(
      handlers["project.trust"]?.({ cwd: CWD, answer: "maybe" }, {} as never),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("inspects a folder through the configured adapter", async () => {
    const inspect = vi.fn(async () => INSPECTION);
    const handlers = createProjectHandlers({ inspectProject: inspect }).handlers();

    const result = await handlers["project.inspect"]?.({ cwd: CWD }, {} as never);

    expect(inspect).toHaveBeenCalledWith(CWD);
    expect(result).toEqual(INSPECTION);
  });

  it("reads trust status and records an answer", async () => {
    const trust = trustWith(true);
    const handlers = createProjectHandlers({ trust }).handlers();

    const before = (await handlers["project.trust"]?.({ cwd: CWD }, {} as never)) as {
      trusted: boolean;
      needsPrompt: boolean;
    };
    expect(before).toMatchObject({ trusted: false, needsPrompt: true });

    const answered = (await handlers["project.trust"]?.(
      { cwd: CWD, answer: "trust" },
      {} as never,
    )) as { trusted: boolean };
    expect(answered.trusted).toBe(true);
    expect(trust.status(CWD).trusted).toBe(true);
  });

  it("is exposed by the control core and declared in CONTROL_METHODS", () => {
    const core = createControlCore({
      createSettings: () => ({}),
      listSessions: async () => [],
      projectInspect: async () => INSPECTION,
      trust: trustWith(true),
    });
    const keys = Object.keys(core.handlers());
    expect(keys).toContain("project.inspect");
    expect(keys).toContain("project.trust");
    expect([...CONTROL_METHODS]).toEqual(
      expect.arrayContaining(["project.inspect", "project.trust"]),
    );
  });
});
