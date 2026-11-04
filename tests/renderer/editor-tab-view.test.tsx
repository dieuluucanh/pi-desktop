import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom cannot run CodeMirror's layout, and this test is about the *load
// lifecycle*, not the editor internals. The stub renders the doc so a refresh
// can be observed without a real EditorView.
vi.mock("../../src/renderer/src/editor/CodeMirrorEditor", () => ({
  CodeMirrorEditor: ({
    tabId,
    doc,
    autoFocus,
  }: {
    tabId: string;
    doc: string;
    autoFocus?: boolean;
  }) => (
    <div
      data-testid="cm-stub"
      data-tab={tabId}
      data-doc={doc}
      data-autofocus={autoFocus === false ? "false" : "true"}
    />
  ),
}));

import { getBuffer } from "../../src/renderer/src/editor/buffer-registry";
import { useEditorStore } from "../../src/renderer/src/editor/editor-store";
import { EditorTabView } from "../../src/renderer/src/views/EditorTabView";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import type { WorkspaceFileContent } from "../../src/shared/workspace";
import { installBridge } from "./fixtures";

/**
 * Editor load lifecycle (2026-11-03 plan step 7).
 *
 * The reported "loads 2–3 times and flashes" was `EditorTabView` re-reading the
 * file on every tab-table publish. The effect now keys on the tab id, and an
 * existing buffer keeps the editor mounted through a refresh.
 */

const WORK = "C:\\work\\pi-desktop";
const TAB = "editor-1";

function editorTab(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: TAB,
    kind: "editor",
    cwd: WORK,
    title: "a.ts",
    sessionFile: null,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
    filePath: "a.ts",
    ...overrides,
  };
}

function textFile(
  text: string,
  overrides: Partial<WorkspaceFileContent> = {},
): { ok: true; value: WorkspaceFileContent } {
  return {
    ok: true as const,
    value: {
      path: `${WORK}\\a.ts`,
      relativePath: "a.ts",
      kind: "text",
      text,
      bytes: text.length,
      size: text.length,
      mtimeMs: 1,
      truncated: false,
      eol: "lf",
      bom: false,
      encoding: "utf8",
      ...overrides,
    },
  };
}

function workspaceMock(readFile: ReturnType<typeof vi.fn>, stat: ReturnType<typeof vi.fn>) {
  const { bridge } = installBridge();
  const workspace = bridge.workspace as unknown as Record<string, unknown>;
  workspace.readFile = readFile;
  workspace.readBackup = vi.fn(async () => ({ ok: true as const, value: null }));
  workspace.deleteBackup = vi.fn(async () => ({ ok: true as const, value: true }));
  workspace.stat = stat;
  return workspace;
}

function statFile(mtimeMs: number) {
  return {
    ok: true as const,
    value: {
      path: `${WORK}\\a.ts`,
      relativePath: "a.ts",
      kind: "file" as const,
      size: 8,
      mtimeMs,
    },
  };
}

beforeEach(() => {
  useEditorStore.getState().clearExcept(new Set());
  useEditorStore.setState({ pendingClose: null });
  useAppStore.setState({
    tabs: [editorTab()],
    activeTabId: TAB,
    hint: null,
    prefs: { ...DEFAULT_PREFS, drafts: {} },
  });
});

describe("EditorTabView loading", () => {
  it("reads once and keeps the surface mounted when the tab object changes", async () => {
    const readFile = vi.fn(async () => textFile("one"));
    const stat = vi.fn(async () => statFile(1));
    workspaceMock(readFile, stat);

    const { rerender } = render(<EditorTabView tab={editorTab()} />);
    const surface = await screen.findByTestId("cm-stub");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Loading file…")).toBeNull();

    // A new object with the same fields is exactly what `applyTabs` used to
    // hand the view on every publish.
    rerender(<EditorTabView tab={{ ...editorTab() }} />);
    await Promise.resolve();

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("cm-stub")).toBe(surface);
    expect(screen.queryByText("Loading file…")).toBeNull();
  });

  it("stats instead of re-reading when an already-loaded tab remounts", async () => {
    const readFile = vi.fn(async () => textFile("one"));
    const stat = vi.fn(async () => statFile(1));
    workspaceMock(readFile, stat);

    const first = render(<EditorTabView tab={editorTab()} />);
    await screen.findByTestId("cm-stub");
    first.unmount();

    render(<EditorTabView tab={editorTab()} />);
    await waitFor(() => expect(stat).toHaveBeenCalled());

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("cm-stub")).toBeVisible();
  });

  it("shows the loading surface only until the first read lands", async () => {
    let release: (() => void) | undefined;
    const readFile = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve(textFile("one"));
        }),
    );
    workspaceMock(
      readFile,
      vi.fn(async () => statFile(1)),
    );

    render(<EditorTabView tab={editorTab()} />);
    expect(await screen.findByText("Loading file…")).toBeInTheDocument();

    release?.();
    await screen.findByTestId("cm-stub");
    expect(screen.queryByText("Loading file…")).toBeNull();
    expect(getBuffer(TAB)?.text).toBe("one");
  });

  it("only focuses the editor when its tab is the active one", async () => {
    const readFile = vi.fn(async () => textFile("one"));
    const stat = vi.fn(async () => statFile(1));
    workspaceMock(readFile, stat);
    // A grid can mount several editors; a background pane must not steal the caret.
    useAppStore.setState({ activeTabId: "editor-2" });

    render(<EditorTabView tab={editorTab()} />);
    expect(await screen.findByTestId("cm-stub")).toHaveAttribute("data-autofocus", "false");

    act(() => useAppStore.setState({ activeTabId: TAB }));
    await waitFor(() =>
      expect(screen.getByTestId("cm-stub")).toHaveAttribute("data-autofocus", "true"),
    );
  });

  it("keeps the editor mounted and shows Reloading… during a refresh", async () => {
    const readFile = vi.fn(async () => textFile("one"));
    workspaceMock(
      readFile,
      vi.fn(async () => statFile(1)),
    );

    render(<EditorTabView tab={editorTab()} />);
    const surface = await screen.findByTestId("cm-stub");

    let release: (() => void) | undefined;
    readFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(textFile("two", { mtimeMs: 2 }));
        }),
    );

    let run: Promise<void> | undefined;
    act(() => {
      run = useEditorStore.getState().load(TAB);
    });
    expect(screen.getByTestId("editor-refreshing")).toBeInTheDocument();
    expect(screen.getByTestId("cm-stub")).toBe(surface);

    act(() => {
      release?.();
    });
    await act(async () => {
      await run;
    });

    expect(screen.queryByTestId("editor-refreshing")).toBeNull();
    expect(screen.getByTestId("cm-stub")).toBe(surface);
    expect(screen.getByTestId("cm-stub")).toHaveAttribute("data-doc", "two");
  });
});
