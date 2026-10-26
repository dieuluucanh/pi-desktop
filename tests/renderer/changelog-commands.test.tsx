import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChangelogDialog } from "../../src/renderer/src/sessions/ChangelogDialog";
import { APP_COMMANDS, findAppCommand } from "../../src/renderer/src/completion/app-commands";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * `/changelog`, `/hotkeys`, `/help`, `/quit` (session-parity plan step 15).
 *
 * Terminal Pi exposes all four. `/help` already lists the app table, so the
 * table must carry the new names; `/hotkeys` opens the existing help dialog;
 * `/quit` closes the session tab; `/changelog` renders Pi's packaged notes.
 */

const TAB = "tab-1";

function tab(): TabRecord {
  return {
    id: TAB,
    kind: "session",
    cwd: "/work/app",
    title: "app",
    sessionFile: "/profile/s1.jsonl",
    status: "running",
    createdAt: 0,
    lastActiveAt: 0,
    model: "test-model",
  };
}

function stubRequest(impl: (input: { method: string; params?: unknown }) => Promise<unknown>) {
  const request = vi.fn(async (input: { method: string; params?: unknown }) => impl(input));
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    tabs: [tab()],
    activeTabId: TAB,
    changelogOpen: false,
    changelogPath: null,
    changelogText: null,
    changelogError: null,
    shortcutsHelpOpen: false,
    hint: null,
  });
});

describe("command table", () => {
  it("carries every terminal command added by the session-parity plan", () => {
    const names = APP_COMMANDS.map((command) => command.name);
    for (const name of [
      "copy",
      "session",
      "import",
      "export",
      "changelog",
      "hotkeys",
      "quit",
      "clone",
    ]) {
      expect(names).toContain(name);
    }
    expect(findAppCommand("export")?.argumentKind).toBe("exportFormat");
  });
});

describe("/help", () => {
  it("lists the new commands", async () => {
    stubRequest(async () => ({}));
    await useAppStore.getState().runCommandInput(TAB, "/help");
    const hint = useAppStore.getState().hint ?? "";
    expect(hint).toContain("changelog");
    expect(hint).toContain("hotkeys");
    expect(hint).toContain("quit");
  });
});

describe("/hotkeys and /quit", () => {
  it("opens the shortcuts help", async () => {
    stubRequest(async () => ({}));
    await useAppStore.getState().runCommandInput(TAB, "/hotkeys");
    expect(useAppStore.getState().shortcutsHelpOpen).toBe(true);
  });

  it("closes the session tab", async () => {
    stubRequest(async () => ({}));
    const close = vi.fn(async () => undefined);
    useAppStore.setState({ closeTab: close });
    await useAppStore.getState().runCommandInput(TAB, "/quit");
    expect(close).toHaveBeenCalledWith(TAB);
  });
});

describe("/changelog", () => {
  it("asks the host for the packaged file and renders it", async () => {
    const request = stubRequest(async (input) =>
      input.method === "session.changelog"
        ? { path: "/pkg/CHANGELOG.md", text: "## 1.4.0\n- new things" }
        : {},
    );

    await useAppStore.getState().openChangelog();

    expect(request).toHaveBeenCalledWith({ tabId: TAB, method: "session.changelog" });
    expect(useAppStore.getState().changelogOpen).toBe(true);
    render(<ChangelogDialog />);
    await waitFor(() => {
      expect(screen.getByTestId("changelog")).toHaveTextContent("- new things");
    });
  });

  it("explains a build without the file", async () => {
    stubRequest(async () => ({ path: "/pkg/CHANGELOG.md", text: null }));
    await useAppStore.getState().openChangelog();
    render(<ChangelogDialog />);
    await waitFor(() => {
      expect(screen.getByTestId("changelog")).toHaveTextContent(/does not ship Pi's changelog/);
    });
  });

  it("shows a host error", async () => {
    stubRequest(async () => {
      throw new Error("host gone");
    });
    await useAppStore.getState().openChangelog();
    render(<ChangelogDialog />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("host gone");
    });
  });
});
