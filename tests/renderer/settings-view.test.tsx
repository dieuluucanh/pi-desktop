import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "../../src/renderer/src/views/SettingsView";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { SettingsSnapshot } from "../../src/shared/settings";
import { installBridge } from "./fixtures";

/**
 * Settings view (plan step 12).
 *
 * The load-bearing behaviours: every schema group renders, a control writes to
 * the scope the user chose, the raw editor writes a whole document, a terminal-Pi
 * edit is surfaced with a reload action, and a global-only key never offers a
 * project scope.
 */

const PROJECT = "C:/work/app";

function snapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    settings: {
      global: { theme: "dark", compaction: { enabled: true } },
      project: {},
    },
    errors: [],
    files: {
      global: { path: "/profile/agent/settings.json", exists: true, mtimeMs: 100 },
      project: { path: `${PROJECT}/.pi/settings.json`, exists: true, mtimeMs: 200 },
    },
    projectTrusted: true,
    ...overrides,
  };
}

function stubRequest(impl?: (method: string, params?: unknown) => Promise<unknown>) {
  const request = vi.fn(async (input: { method: string; params?: unknown }) => {
    if (impl) return impl(input.method, input.params);
    if (input.method === "settings.get") return snapshot();
    return snapshot();
  });
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    project: { path: PROJECT, name: "app" },
    settingsCwd: null,
    settings: null,
    settingsLoaded: false,
    settingsBusy: false,
    settingsError: null,
    settingsErrors: [],
    settingsFiles: null,
    settingsProjectTrusted: true,
    settingsMtimes: { global: null, project: null },
    settingsExternalEdit: false,
  });
});

describe("SettingsView", () => {
  it("renders every schema group with its fields", async () => {
    stubRequest();
    render(<SettingsView />);

    await waitFor(() =>
      expect(screen.getByTestId("settings-group-compaction")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("settings-group-model-thinking")).toBeInTheDocument();
    expect(screen.getByTestId("settings-group-resources")).toBeInTheDocument();
    expect(screen.getByTestId("setting-compaction.enabled")).toBeInTheDocument();
    // The provenance badge explains where the effective value comes from.
    const field = screen.getByTestId("setting-compaction.enabled");
    expect(within(field).getByText("global")).toBeInTheDocument();
  });

  it("writes a boolean to the global scope", async () => {
    const request = stubRequest();
    render(<SettingsView />);
    const toggle = await screen.findByRole("switch", { name: "Auto-compaction" });
    await userEvent.click(toggle);

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "control",
        method: "settings.set",
        params: { cwd: PROJECT, key: "compaction.enabled", value: false, scope: "global" },
      }),
    );
  });

  it("writes to the project scope when that scope is selected", async () => {
    const request = stubRequest();
    render(<SettingsView />);
    const field = await screen.findByTestId("setting-compaction.enabled");
    await userEvent.click(within(field).getByRole("button", { name: "Project" }));
    await userEvent.click(within(field).getByRole("switch"));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "control",
        method: "settings.set",
        params: { cwd: PROJECT, key: "compaction.enabled", value: false, scope: "project" },
      }),
    );
  });

  it("applies a raw JSON document", async () => {
    const request = stubRequest();
    render(<SettingsView />);
    await screen.findByTestId("setting-compaction.enabled");

    await userEvent.click(screen.getByRole("button", { name: "Raw JSON…" }));
    const textarea = await screen.findByTestId("settings-raw-textarea");
    fireEvent.change(textarea, { target: { value: '{"theme":"light"}' } });
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "control",
        method: "settings.raw",
        params: { cwd: PROJECT, scope: "global", document: { theme: "light" } },
      }),
    );
  });

  it("surfaces a terminal-Pi edit and reloads it", async () => {
    stubRequest();
    useAppStore.setState({ settingsExternalEdit: true });
    render(<SettingsView />);

    expect(screen.getByText(/changed on disk/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reload from disk" }));
    await waitFor(() => expect(useAppStore.getState().settingsExternalEdit).toBe(false));
  });

  it("resets a scope to the documented defaults", async () => {
    const request = stubRequest();
    render(<SettingsView />);
    await screen.findByTestId("setting-compaction.enabled");

    await userEvent.click(screen.getByRole("button", { name: "Reset to defaults…" }));
    const dialog = await screen.findByTestId("settings-reset-dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reset" }));

    await waitFor(() => {
      const call = request.mock.calls.find(
        ([input]) => (input as { method: string }).method === "settings.raw",
      )?.[0] as unknown as { params: { scope: string; document: Record<string, unknown> } };
      expect(call.params.scope).toBe("global");
      expect(call.params.document.theme).toBe("dark");
    });
  });

  it("does not offer a project scope without a project", async () => {
    stubRequest();
    useAppStore.setState({ project: null });
    render(<SettingsView />);

    const field = await screen.findByTestId("setting-compaction.enabled");
    expect(within(field).queryByRole("button", { name: "Project" })).toBeNull();
    expect(screen.getByText(/No project is open/i)).toBeInTheDocument();
  });
});
