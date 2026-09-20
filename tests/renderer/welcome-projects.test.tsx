import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { ProjectRecord } from "../../src/shared/projects";
import { WelcomeView } from "../../src/renderer/src/views/WelcomeView";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { appInfoFixture, installBridge } from "./fixtures";

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

beforeEach(() => {
  installBridge();
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
    providers: [],
    providersLoaded: false,
    providersError: null,
    info: appInfoFixture(),
    hint: null,
    tabs: [],
    activeTabId: null,
  });
});

describe("WelcomeView projects", () => {
  it("offers every way into a project", () => {
    render(<WelcomeView />);

    expect(screen.getByRole("button", { name: /open project folder/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create blank project/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clone repository/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /quick session in home/i })).toBeInTheDocument();
  });

  it("lists recent projects and opens one on click", async () => {
    useAppStore.setState({ projects: [record(PATH), record("C:\\work\\other")] });
    render(<WelcomeView />);

    expect(screen.getByTestId("recent-projects")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /pi-desktop/ }));

    expect(useAppStore.getState().project?.path).toBe(PATH);
  });

  it("opens the create dialog with the home folder prefilled", async () => {
    render(<WelcomeView />);

    await userEvent.click(screen.getByRole("button", { name: /create blank project/i }));

    expect(screen.getByText("Create a blank project")).toBeInTheDocument();
    expect(screen.getByLabelText("Parent folder")).toHaveValue("C:\\Users\\test");
  });

  it("opens the clone dialog", async () => {
    render(<WelcomeView />);

    await userEvent.click(screen.getByRole("button", { name: /clone repository/i }));

    expect(screen.getByText("Clone a repository")).toBeInTheDocument();
    expect(screen.getByLabelText("Repository URL")).toBeInTheDocument();
  });
});
