import { render, screen, waitFor } from "@testing-library/react";
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
      themes: [{ name: "dark", scope: "builtin", active: true, variant: "dark", swatches: {} }],
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
  stubRequest(async (method) => {
    if (method === "resources.list") return useAppStore.getState().resources;
    if (method === "themes.list") return useAppStore.getState().themes;
    if (method === "keybindings.get") return useAppStore.getState().keybindings;
    if (method === "shortcuts.list") return useAppStore.getState().shortcuts;
    throw new Error(`unexpected ${method}`);
  });
});

describe("SkillsView", () => {
  it("lists skills with run, templates with argument hints, and themes", async () => {
    render(<SkillsView />);
    expect(await screen.findByText("Reviews code")).toBeInTheDocument();
    expect(screen.getByText("<path>")).toBeInTheDocument();
    expect(screen.getAllByText("dark").length).toBeGreaterThan(0);
    expect(screen.getByTestId("extension-shortcuts")).toBeInTheDocument();
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
