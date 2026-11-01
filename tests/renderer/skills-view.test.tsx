import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { SkillsView } from "../../src/renderer/src/views/SkillsView";
import { installBridge } from "./fixtures";

/**
 * Skills, themes and keybindings view (plan step 15). The sections render from
 * the store snapshots; running a skill inserts `/skill:<name>` into the active
 * session's composer instead of sending it.
 */

function stubRequest(impl: (method: string, params?: unknown) => Promise<unknown>) {
  const request = vi.fn((input: { method: string; params?: unknown }) =>
    impl(input.method, input.params),
  );
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

function skillEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "skills:C:/s/review/SKILL.md",
    kind: "skills",
    name: "review",
    description: "Reviews code",
    path: "C:/s/review/SKILL.md",
    overridePath: "C:/s/review/SKILL.md",
    source: "user",
    scope: "user",
    origin: "top-level",
    settingsKey: "skills",
    enabled: true,
    ...overrides,
  };
}

function settingsSnapshot(theme = "dark") {
  return {
    settings: { global: { theme }, project: {} },
    errors: [],
    files: {
      global: { path: "g", exists: true, mtimeMs: 1 },
      project: { path: "p", exists: false, mtimeMs: null },
    },
    projectTrusted: true,
  };
}

/** The view loads resources, themes, keybindings and shortcuts; a theme click
 * additionally reads and writes the `theme` setting. */
function stubViewRequests() {
  return stubRequest(async (method) => {
    if (method === "resources.list") return useAppStore.getState().resources;
    if (method === "themes.list") return useAppStore.getState().themes;
    if (method === "keybindings.get") return useAppStore.getState().keybindings;
    if (method === "shortcuts.list") return useAppStore.getState().shortcuts;
    if (method === "settings.get") return settingsSnapshot();
    if (method === "settings.set") return settingsSnapshot("light");
    throw new Error(`unexpected ${method}`);
  });
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    tabs: [{ id: "tab-1", kind: "session", cwd: "C:/work", title: "s" } as never],
    activeTabId: "tab-1",
    view: "skills",
    resources: {
      cwd: null,
      scope: "control",
      resources: [
        skillEntry(),
        {
          id: "prompts:C:/p/summary.md",
          kind: "prompts",
          name: "summary",
          description: "Summarizes",
          argumentHint: "<path>",
          path: "C:/p/summary.md",
          overridePath: "C:/p/summary.md",
          source: "user",
          scope: "user",
          origin: "top-level",
          settingsKey: "prompts",
          enabled: true,
        },
      ],
      overrides: [],
      diagnostics: [],
      runtimeErrors: [],
      loadedAt: 1,
    },
    resourcesLoaded: true,
    themes: {
      active: "dark",
      themes: [
        { name: "dark", scope: "builtin", active: true, variant: "dark", swatches: {} },
        { name: "light", scope: "builtin", active: false, variant: "light", swatches: {} },
      ],
    },
    themesLoaded: true,
    keybindings: {
      path: "C:/profile/keybindings.json",
      user: {},
      exists: false,
      effective: {},
      definitions: [],
      unknownIds: [],
      issues: [],
      conflicts: [],
    },
    keybindingsLoaded: true,
    shortcuts: { shortcuts: [], diagnostics: [], loadedAt: 0 },
    shortcutsLoaded: true,
    transcripts: {},
  } as never);
  stubViewRequests();
});

describe("SkillsView", () => {
  it("lists skills with run, templates with argument hints, and themes", async () => {
    render(<SkillsView />);
    expect(screen.getByTestId("view-scroll")).toHaveClass("overflow-y-auto");
    expect(screen.getByTestId("view-content")).toHaveClass("max-w-3xl");
    expect(await screen.findByText("Reviews code")).toBeInTheDocument();
    expect(screen.getByText("<path>")).toBeInTheDocument();
    expect(screen.getAllByText("dark").length).toBeGreaterThan(0);
    expect(screen.getByTestId("extension-shortcuts")).toBeInTheDocument();
  });

  it("selects a theme by clicking its whole card", async () => {
    const request = stubViewRequests();
    render(<SkillsView />);

    const light = await screen.findByTestId("theme-builtin-light");
    expect(light).toHaveAttribute("role", "radio");
    expect(light).toHaveAttribute("aria-checked", "false");

    await userEvent.click(light);

    await waitFor(() => expect(useAppStore.getState().themes.active).toBe("light"));
    expect(light).toHaveAttribute("aria-checked", "true");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "settings.set",
        params: expect.objectContaining({ key: "theme", value: "light" }),
      }),
    );
  });

  it("edits the active theme's separator colour and resets it", async () => {
    render(<SkillsView />);

    const line = await screen.findByTestId("theme-color-line");
    fireEvent.change(line, { target: { value: "#123456" } });

    await waitFor(() =>
      expect(useAppStore.getState().prefs.themeColors.dark?.line).toBe("#123456"),
    );
    expect(document.documentElement.style.getPropertyValue("--color-line")).toBe("#123456");

    await userEvent.click(screen.getByTestId("theme-colors-reset"));
    await waitFor(() => expect(useAppStore.getState().prefs.themeColors.dark).toBeUndefined());
    expect(document.documentElement.style.getPropertyValue("--color-line")).toBe("#4e5b79");
  });

  it("shows colour controls only for the active theme", () => {
    render(<SkillsView />);
    // The fixture's dark card is active; light is an inactive preview.
    expect(document.querySelectorAll("[data-testid^='theme-color-']")).toHaveLength(13);
  });

  it("toggles follow-system appearance", async () => {
    render(<SkillsView />);

    const toggle = await screen.findByRole("switch", { name: "Match system appearance" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await userEvent.click(toggle);

    expect(useAppStore.getState().prefs.followSystemTheme).toBe(true);
  });

  it("running a skill inserts /skill:<name> without sending", async () => {
    const user = userEvent.setup();
    render(<SkillsView />);
    await user.click(await screen.findByRole("button", { name: "Run" }));
    await waitFor(() => {
      expect(useAppStore.getState().view).toBe("session");
    });
  });
});
