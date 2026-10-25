import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { ProjectInspection, ProjectRecord } from "../../src/shared/projects";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { installBridge } from "./fixtures";

/**
 * Projects and the trust flow in the renderer store (plan step 10). The main
 * process owns persistence; these tests pin what the store does with the
 * snapshots it gets back and that a trust refusal becomes a prompt.
 */

const PATH = "C:\\work\\pi-desktop";

function record(path: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    path,
    name: path.slice(path.lastIndexOf("\\") + 1),
    addedAt: 1,
    lastOpenedAt: 1,
    ...overrides,
  };
}

function inspection(cwd: string, overrides: Partial<ProjectInspection> = {}): ProjectInspection {
  return {
    cwd,
    name: "pi-desktop",
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
    sessionDir: "C:\\Users\\test\\.pi\\agent\\sessions\\--C--work-pi-desktop--",
    trust: {
      cwd,
      requiresTrust: true,
      decision: null,
      trusted: false,
      needsPrompt: true,
    },
    ...overrides,
  };
}

function resetStore(): void {
  useAppStore.setState({
    view: "welcome",
    project: null,
    projects: [],
    projectsLoaded: false,
    projectInspections: {},
    projectInspectionErrors: {},
    trustPrompt: null,
    trustBusy: false,
    sessionTrust: [],
    prefs: { ...DEFAULT_PREFS },
    paletteOpen: false,
    info: null,
    hint: null,
    tabs: [],
    activeTabId: null,
    transcripts: {},
    sessionStates: {},
    sendModes: {},
    draftHistory: {},
    historyIndex: {},
    picker: null,
  });
}

beforeEach(() => {
  resetStore();
});

describe("project list", () => {
  it("loads the remembered projects and restores the active one", async () => {
    installBridge({ projects: [record(PATH)], activeProject: PATH });

    await useAppStore.getState().loadProjects();

    const state = useAppStore.getState();
    expect(state.projects).toHaveLength(1);
    expect(state.project).toEqual({ path: PATH, name: "pi-desktop" });
    expect(state.projectsLoaded).toBe(true);
    expect(state.view).toBe("session");
  });

  it("adds and activates a project when opening a folder", async () => {
    const { bridge } = installBridge();
    const mutate = vi.spyOn(bridge.projects, "mutate");

    await useAppStore.getState().openProject(PATH);

    expect(mutate).toHaveBeenCalledWith({ action: "add", path: PATH });
    expect(useAppStore.getState().project?.path).toBe(PATH);
  });

  it("clears the active project when the removed one was active", async () => {
    installBridge({ projects: [record(PATH)], activeProject: PATH });
    await useAppStore.getState().loadProjects();

    await useAppStore.getState().removeProject(PATH);

    expect(useAppStore.getState().projects).toEqual([]);
    expect(useAppStore.getState().project).toBeNull();
  });

  it("stores the project settings toggle through a mutation", async () => {
    installBridge({ projects: [record(PATH)], activeProject: PATH });
    await useAppStore.getState().loadProjects();
    const { bridge } = installBridge({ projects: [record(PATH)], activeProject: PATH });
    const mutate = vi.spyOn(bridge.projects, "mutate");

    await useAppStore.getState().updateProjectConfig(PATH, { useProjectSettings: true });

    expect(mutate).toHaveBeenCalledWith({
      action: "update",
      path: PATH,
      patch: { useProjectSettings: true },
    });
  });
});

describe("project inspection", () => {
  it("caches a successful inspection and clears a previous error", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async () => inspection(PATH));
    (bridge.sessions as unknown as { request: unknown }).request = request;
    useAppStore.setState({ projectInspectionErrors: { [PATH]: "old failure" } });

    const result = await useAppStore.getState().inspectProject(PATH);

    expect(result?.gitBranch).toBe("main");
    expect(useAppStore.getState().projectInspections[PATH]?.sessionDir).toContain("--C--work");
    expect(useAppStore.getState().projectInspectionErrors[PATH]).toBeUndefined();
  });

  it("records an inspection failure without throwing", async () => {
    const { bridge } = installBridge();
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => {
      throw new Error("host is gone");
    });

    const result = await useAppStore.getState().inspectProject(PATH);

    expect(result).toBeNull();
    expect(useAppStore.getState().projectInspectionErrors[PATH]).toBe("host is gone");
  });
});

describe("session creation with project settings", () => {
  it("does not send retired app-state defaults into the create request", async () => {
    installBridge({
      projects: [record(PATH, { useProjectSettings: true })],
      activeProject: PATH,
    });
    await useAppStore.getState().loadProjects();
    const { bridge } = installBridge();
    const create = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { create: unknown }).create = create;

    await useAppStore.getState().createSessionTab();

    expect(create).toHaveBeenCalledWith({ cwd: PATH });
  });

  it("passes the session trust grant to a second tab", async () => {
    installBridge({ projects: [record(PATH)], activeProject: PATH });
    await useAppStore.getState().loadProjects();
    useAppStore.setState({ sessionTrust: [PATH] });
    const { bridge } = installBridge();
    const create = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { create: unknown }).create = create;

    await useAppStore.getState().createSessionTab();

    expect(create).toHaveBeenCalledWith({ cwd: PATH, trust: "session" });
  });
});

describe("trust flow", () => {
  it("raises a prompt from a project_trust event and keeps it out of the transcript", () => {
    useAppStore.setState({
      tabs: [
        {
          id: "tab-1",
          kind: "session",
          cwd: PATH,
          title: "pi-desktop",
          sessionFile: null,
          status: "failed",
          createdAt: 1,
          lastActiveAt: 1,
          model: null,
        },
      ],
    });

    useAppStore.getState().applySessionEvents({
      tabId: "tab-1",
      seq: 1,
      events: [
        {
          event: "project_trust",
          payload: {
            cwd: PATH,
            requiresTrust: true,
            decision: null,
            trusted: false,
            needsPrompt: true,
          },
        },
      ],
    });

    expect(useAppStore.getState().trustPrompt).toMatchObject({ cwd: PATH, tabId: "tab-1" });
    expect(useAppStore.getState().transcripts["tab-1"]).toBeUndefined();
  });

  it("only raises a prompt when the project needs a decision", async () => {
    const { bridge } = installBridge();
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () =>
      inspection(PATH, {
        trust: {
          cwd: PATH,
          requiresTrust: false,
          decision: null,
          trusted: true,
          needsPrompt: false,
        },
      }),
    );

    const raised = await useAppStore.getState().openTrustPrompt(PATH);
    expect(raised).toBe(false);
    expect(useAppStore.getState().trustPrompt).toBeNull();
  });

  it("retries session.create with the answer and closes the prompt", async () => {
    const { bridge } = installBridge();
    const requests: Array<{ method: string; params?: unknown }> = [];
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(
      async (input: { method: string; params?: unknown }) => {
        requests.push(input);
        if (input.method === "project.inspect") return inspection(PATH);
        return { sessionId: "session-1" };
      },
    );
    useAppStore.setState({
      trustPrompt: {
        cwd: PATH,
        tabId: "tab-1",
        status: {
          cwd: PATH,
          requiresTrust: true,
          decision: null,
          trusted: false,
          needsPrompt: true,
        },
      },
    });

    await useAppStore.getState().answerTrust("session");

    expect(requests).toContainEqual({
      tabId: "tab-1",
      method: "session.create",
      params: { cwd: PATH, trust: "session" },
    });
    expect(useAppStore.getState().sessionTrust).toContain(PATH);
    expect(useAppStore.getState().trustPrompt).toBeNull();
    expect(useAppStore.getState().view).toBe("session");
  });

  it("answers trust through the control host when no tab is waiting", async () => {
    const { bridge } = installBridge();
    const requests: Array<{ tabId: string; method: string; params?: unknown }> = [];
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(
      async (input: { tabId: string; method: string; params?: unknown }) => {
        requests.push(input);
        return inspection(PATH);
      },
    );
    useAppStore.setState({
      trustPrompt: {
        cwd: PATH,
        tabId: null,
        status: {
          cwd: PATH,
          requiresTrust: true,
          decision: null,
          trusted: false,
          needsPrompt: true,
        },
      },
    });

    await useAppStore.getState().answerTrust("trust");

    expect(requests[0]).toMatchObject({
      tabId: "control",
      method: "project.trust",
      params: { cwd: PATH, answer: "trust" },
    });
    expect(useAppStore.getState().sessionTrust).not.toContain(PATH);
  });

  it("dismisses a prompt without trusting", () => {
    useAppStore.setState({
      trustPrompt: {
        cwd: PATH,
        tabId: "tab-1",
        status: {
          cwd: PATH,
          requiresTrust: true,
          decision: null,
          trusted: false,
          needsPrompt: true,
        },
      },
    });
    useAppStore.getState().dismissTrust();
    expect(useAppStore.getState().trustPrompt).toBeNull();
  });
});

describe("/trust", () => {
  it("opens the prompt for the session's project", async () => {
    const { bridge } = installBridge();
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(
      async (input: { method: string }) => {
        if (input.method === "commands.list") return { commands: [] };
        if (input.method === "project.inspect") return inspection(PATH);
        return {};
      },
    );
    useAppStore.setState({
      tabs: [
        {
          id: "tab-1",
          kind: "session",
          cwd: PATH,
          title: "pi-desktop",
          sessionFile: null,
          status: "failed",
          createdAt: 1,
          lastActiveAt: 1,
          model: null,
        },
      ],
      project: { path: PATH, name: "pi-desktop" },
    });

    const outcome = await useAppStore.getState().runCommandInput("tab-1", "/trust");

    expect(outcome).toEqual({ handled: true, sent: false });
    expect(useAppStore.getState().trustPrompt).toMatchObject({ cwd: PATH, tabId: "tab-1" });
  });
});
