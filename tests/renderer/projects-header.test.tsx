import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { ProjectsHeader } from "../../src/renderer/src/projects/ProjectsHeader";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { installBridge } from "./fixtures";

/**
 * The Projects header owns the project entry points (minimal-session-ui step 2)
 * and is pinned by `layout/Sidebar.tsx` above the scroller (2026-11-19). These
 * tests cover the controls themselves; `projects-section.test.tsx` covers the
 * list the header sits above, and `sidebar.test.tsx` pins the pinned placement.
 */

const DEFAULT_PATH = "C:\\Users\\test\\Documents\\Pi-Desktop\\2026-11-03T10-15-42";

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

describe("ProjectsHeader", () => {
  it("offers the default project first in the + menu", async () => {
    installBridge();
    const user = userEvent.setup();
    render(<ProjectsHeader />);

    screen.getByRole("button", { name: "New project" }).focus();
    await user.keyboard("{Enter}");

    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "New default project",
      "New project…",
      "Clone repository…",
    ]);
  });

  it("creates a default project and starts a session from the + menu", async () => {
    const { bridge } = installBridge();
    const createDefault = vi.spyOn(bridge.projects, "createDefault");
    const createSession = vi.spyOn(bridge.sessions, "create");
    const user = userEvent.setup();
    render(<ProjectsHeader />);

    screen.getByRole("button", { name: "New project" }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "New default project" }));

    await waitFor(() => expect(createDefault).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: DEFAULT_PATH })),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the new-project dialog from the + menu", async () => {
    installBridge();
    const user = userEvent.setup();
    render(<ProjectsHeader />);

    expect(screen.getByRole("button", { name: "Open project folder" })).toBeInTheDocument();

    // Keyboard-open the menu: a preceding Radix menu/dialog can leave a pointer
    // lock that swallows the trigger's pointerdown in jsdom (see the setup
    // shims note); the keyboard path is the same menu and is deterministic.
    screen.getByRole("button", { name: "New project" }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: /new project/i }));
    expect(
      await screen.findByRole("dialog", { name: "Create a blank project" }),
    ).toBeInTheDocument();
    // Close it before the test ends: a live Radix dialog leaves a body
    // pointer-events/aria-hidden lock that would poison the next test.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("collapses the sidebar from the Projects header", async () => {
    installBridge();
    render(<ProjectsHeader />);
    await userEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(useAppStore.getState().prefs.sidebarCollapsed).toBe(true);
  });

  it("opens the clone dialog from the + menu", async () => {
    installBridge();
    const user = userEvent.setup();
    render(<ProjectsHeader />);

    // Keyboard-open the menu: a preceding Radix dialog can leave a pointer
    // lock that swallows the trigger's pointerdown in jsdom (see the setup
    // shims note); the keyboard path is the same menu and is deterministic.
    screen.getByRole("button", { name: "New project" }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: /clone repository/i }));
    expect(await screen.findByRole("dialog", { name: "Clone a repository" })).toBeInTheDocument();
  });
});
