import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom cannot run CodeMirror's layout, and this test is about the *load
// lifecycle*, not the editor internals. The stub renders the doc so a refresh
// can be observed without a real EditorView. The wrap/measure props are
// forwarded as `data-*` so the language-aware resolution is assertable here.
vi.mock("../../src/renderer/src/editor/CodeMirrorEditor", () => ({
  CodeMirrorEditor: ({
    tabId,
    doc,
    autoFocus,
    wordWrap,
    measure,
    widthColumns,
  }: {
    tabId: string;
    doc: string;
    autoFocus?: boolean;
    wordWrap: boolean;
    measure: "full" | "compact";
    widthColumns: number;
  }) => (
    <div
      data-testid="cm-stub"
      data-tab={tabId}
      data-doc={doc}
      data-autofocus={autoFocus === false ? "false" : "true"}
      data-wordwrap={wordWrap ? "true" : "false"}
      data-measure={measure}
      data-width={String(widthColumns)}
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
  // The per-tab view overrides are session state: reset them per test so a
  // previous case cannot decide this one's effective wrap/measure.
  useEditorStore.setState({ pendingClose: null, wrapOverride: {}, compactOverride: {} });
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

  it("resolves compact and wrapped for prose with the default prefs", async () => {
    const readFile = vi.fn(async () => textFile("# notes"));
    workspaceMock(
      readFile,
      vi.fn(async () => statFile(1)),
    );
    const markdown = editorTab({ filePath: "notes.md", title: "notes.md" });
    // The store re-reads the tab record from `app-store`, so the fixture must be
    // the same tab the view is handed.
    useAppStore.setState({ tabs: [markdown], activeTabId: TAB });

    render(<EditorTabView tab={markdown} />);
    const surface = await screen.findByTestId("cm-stub");

    expect(surface).toHaveAttribute("data-measure", "compact");
    expect(surface).toHaveAttribute("data-wordwrap", "true");
    expect(surface).toHaveAttribute("data-width", "100");
    // The area beside the centred column must match the editor background.
    expect(surface.parentElement).toHaveClass("bg-canvas");
  });

  it("resolves full width and no wrap for code with the default prefs", async () => {
    const readFile = vi.fn(async () => textFile("const a = 1;"));
    workspaceMock(
      readFile,
      vi.fn(async () => statFile(1)),
    );

    render(<EditorTabView tab={editorTab()} />);
    const surface = await screen.findByTestId("cm-stub");

    expect(surface).toHaveAttribute("data-measure", "full");
    expect(surface).toHaveAttribute("data-wordwrap", "false");
  });

  it("passes a widthColumns change through to the editor", async () => {
    const readFile = vi.fn(async () => textFile("# notes"));
    workspaceMock(
      readFile,
      vi.fn(async () => statFile(1)),
    );
    const markdown = editorTab({ filePath: "notes.md", title: "notes.md" });
    useAppStore.setState({ tabs: [markdown], activeTabId: TAB });

    render(<EditorTabView tab={markdown} />);
    expect(await screen.findByTestId("cm-stub")).toHaveAttribute("data-width", "100");

    act(() => {
      useAppStore.setState((state) => ({
        prefs: {
          ...state.prefs,
          editor: { ...state.prefs.editor, widthColumns: 72 },
        },
      }));
    });

    await waitFor(() => expect(screen.getByTestId("cm-stub")).toHaveAttribute("data-width", "72"));
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

/**
 * Per-tab Wrap/Width toggles and `Alt+Z` (2026-11-25 plan step 11).
 *
 * The quick control is session-scoped: it changes what this tab renders and
 * must never write `prefs.editor`, so opening another file keeps its defaults.
 * Cleanup is the store's, not a new close hook: `discard`/`prune` own it.
 */
describe("EditorTabView wrap and width overrides", () => {
  async function mountCodeTab() {
    const readFile = vi.fn(async () => textFile("const a = 1;"));
    workspaceMock(
      readFile,
      vi.fn(async () => statFile(1)),
    );
    const view = render(<EditorTabView tab={editorTab()} />);
    expect(await screen.findByTestId("cm-stub")).toHaveAttribute("data-measure", "full");
    return { readFile, view };
  }

  it("flips wrap on the tab without touching the editor prefs", async () => {
    await mountCodeTab();
    const wrap = screen.getByTestId("editor-wrap");
    expect(wrap).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("cm-stub")).toHaveAttribute("data-wordwrap", "false");

    fireEvent.click(wrap);

    expect(wrap).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("cm-stub")).toHaveAttribute("data-wordwrap", "true");
    // The pref stays the default: only this tab is overridden.
    expect(useAppStore.getState().prefs.editor.wordWrap).toBe("auto");

    fireEvent.click(wrap);
    expect(wrap).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("cm-stub")).toHaveAttribute("data-wordwrap", "false");
  });

  it("switches the measure between full and compact", async () => {
    await mountCodeTab();
    const width = screen.getByTestId("editor-width");
    expect(width).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(width);

    expect(width).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("cm-stub")).toHaveAttribute("data-measure", "compact");
    expect(useAppStore.getState().prefs.editor.width).toBe("auto");

    fireEvent.click(width);
    expect(screen.getByTestId("cm-stub")).toHaveAttribute("data-measure", "full");
  });

  it("toggles wrap on Alt+Z from the editor container", async () => {
    await mountCodeTab();
    const container = screen.getByTestId("editor-tab-view");

    fireEvent.keyDown(container, { key: "z", altKey: true });

    expect(screen.getByTestId("editor-wrap")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("cm-stub")).toHaveAttribute("data-wordwrap", "true");

    fireEvent.keyDown(container, { key: "z", altKey: true });
    expect(screen.getByTestId("cm-stub")).toHaveAttribute("data-wordwrap", "false");
  });

  it("keeps the override across a remount of the same tab", async () => {
    const { view } = await mountCodeTab();
    fireEvent.click(screen.getByTestId("editor-wrap"));
    expect(screen.getByTestId("cm-stub")).toHaveAttribute("data-wordwrap", "true");

    view.unmount();
    render(<EditorTabView tab={editorTab()} />);

    expect(await screen.findByTestId("cm-stub")).toHaveAttribute("data-wordwrap", "true");
    expect(screen.getByTestId("editor-wrap")).toHaveAttribute("aria-pressed", "true");
  });

  it("drops the override for a tab that was discarded", async () => {
    await mountCodeTab();
    fireEvent.click(screen.getByTestId("editor-wrap"));
    fireEvent.click(screen.getByTestId("editor-width"));
    expect(useEditorStore.getState().wrapOverride[TAB]).toBe(true);
    expect(useEditorStore.getState().compactOverride[TAB]).toBe(true);

    await act(async () => {
      await useEditorStore.getState().discard(TAB);
    });

    expect(useEditorStore.getState().wrapOverride[TAB]).toBeUndefined();
    expect(useEditorStore.getState().compactOverride[TAB]).toBeUndefined();
  });
});
