import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { ProjectInspection, ProjectRecord } from "../../src/shared/projects";
import type { TabRecord } from "../../src/shared/session-ipc";
import { ProjectsSection } from "../../src/renderer/src/projects/ProjectsSection";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { installBridge } from "./fixtures";

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

function inspection(): ProjectInspection {
  return {
    cwd: PATH,
    name: "pi-desktop",
    exists: true,
    isDirectory: true,
    gitBranch: "feature/plan-10",
    resources: {
      settings: true,
      agentsMd: true,
      extensions: false,
      skills: true,
      prompts: false,
      themes: false,
      packages: false,
    },
    sessionDir: "C:\\Users\\test\\.pi\\agent\\sessions\\--C--work-pi-desktop--",
    trust: {
      cwd: PATH,
      requiresTrust: true,
      decision: null,
      trusted: false,
      needsPrompt: true,
    },
  };
}

function tab(status: TabRecord["status"]): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: PATH,
    title: "Fix the sidebar",
    sessionFile: null,
    status,
    createdAt: 1,
    lastActiveAt: 2,
    model: null,
  };
}

function resetStore(): void {
  useAppStore.setState({
    view: "welcome",
    project: null,
    projects: [],
    projectsLoaded: true,
    projectInspections: {},
    projectInspectionErrors: {},
    trustPrompt: null,
    trustBusy: false,
    sessionTrust: [],
    prefs: { ...DEFAULT_PREFS },
    hint: null,
    tabs: [],
    activeTabId: null,
    transcripts: {},
    sessionStates: {},
  });
}

beforeEach(() => {
  resetStore();
});

describe("ProjectsSection", () => {
  it("shows the empty state before any project is remembered", () => {
    installBridge();
    render(<ProjectsSection />);
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
  });

  it("renders a project's workspace facts and its sessions", () => {
    installBridge({ projects: [record(PATH)], activeProject: PATH });
    useAppStore.setState({
      projects: [record(PATH, { defaultModel: "anthropic/claude-sonnet-4" })],
      project: { path: PATH, name: "pi-desktop" },
      projectInspections: { [PATH]: inspection() },
      tabs: [tab("running")],
    });

    render(<ProjectsSection />);

    expect(screen.getByText("pi-desktop")).toBeInTheDocument();
    expect(screen.getByText("feature/plan-10")).toBeInTheDocument();
    expect(screen.getByText("settings.json")).toBeInTheDocument();
    expect(screen.getByText("AGENTS.md")).toBeInTheDocument();
    expect(screen.getByText(/sessions\\--C--work-pi-desktop--/)).toBeInTheDocument();
    expect(screen.getByText("anthropic/claude-sonnet-4")).toBeInTheDocument();
    expect(screen.getByText("Fix the sidebar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new session here/i })).toBeInTheDocument();
  });

  it("shows the trust state and asks when it needs a decision", async () => {
    installBridge({ projects: [record(PATH)], activeProject: PATH });
    const request = vi.fn(async () => inspection());
    const { bridge } = installBridge({ projects: [record(PATH)], activeProject: PATH });
    (bridge.sessions as unknown as { request: unknown }).request = request;
    useAppStore.setState({
      projects: [record(PATH)],
      project: { path: PATH, name: "pi-desktop" },
      projectInspections: { [PATH]: inspection() },
    });

    render(<ProjectsSection />);
    const chip = screen.getByTestId("project-trust");
    expect(chip).toHaveTextContent("trust?");

    await userEvent.click(chip);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "project.inspect", params: { cwd: PATH } }),
    );
  });

  it("activates a project when its name is clicked", async () => {
    const { bridge } = installBridge({
      projects: [record(PATH)],
      activeProject: null,
    });
    const mutate = vi.spyOn(bridge.projects, "mutate");
    useAppStore.setState({
      projects: [record(PATH)],
      project: null,
      projectInspections: { [PATH]: inspection() },
    });

    render(<ProjectsSection />);
    await userEvent.click(screen.getByRole("button", { name: "pi-desktop" }));

    expect(mutate).toHaveBeenCalledWith({ action: "activate", path: PATH });
  });

  it("removes a project from the list", async () => {
    const { bridge } = installBridge({ projects: [record(PATH)], activeProject: PATH });
    const mutate = vi.spyOn(bridge.projects, "mutate");
    useAppStore.setState({
      projects: [record(PATH)],
      project: { path: PATH, name: "pi-desktop" },
      projectInspections: { [PATH]: inspection() },
    });

    render(<ProjectsSection />);
    await userEvent.click(
      screen.getByRole("button", { name: /remove pi-desktop from the project list/i }),
    );

    expect(mutate).toHaveBeenCalledWith({ action: "remove", path: PATH });
  });
});
