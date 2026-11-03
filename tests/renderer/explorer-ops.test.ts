import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createExplorerEntry,
  deleteExplorerEntry,
  pasteExplorerEntries,
  renameExplorerEntry,
  revealExplorerPath,
} from "../../src/renderer/src/files/explorer-ops";
import { useExplorerStore } from "../../src/renderer/src/files/explorer-store";
import { useFileClipboardStore } from "../../src/renderer/src/files/file-clipboard-store";
import { useEditorStore } from "../../src/renderer/src/editor/editor-store";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

const PROJECT = "C:\\work\\app";

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

beforeEach(() => {
  installBridge();
  useExplorerStore.setState({
    trees: {},
    searches: {},
    busy: {},
    lastError: {},
  });
  useFileClipboardStore.getState().clear();
  useEditorStore.getState().clearExcept(new Set());
  useAppStore.setState({
    project: { path: PROJECT, name: "app" },
    projects: [],
    projectsLoaded: true,
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    hint: null,
    tabs: [],
    activeTabId: null,
  });
});

describe("explorer create", () => {
  it("creates a file through the workspace bridge and opens it", async () => {
    const { bridge } = installBridge();
    const create = vi.fn(async () =>
      ok({ path: "src/new.ts", absolutePath: "C:\\work\\app\\src\\new.ts", kind: "file" as const }),
    );
    (bridge.workspace as unknown as { create: unknown }).create = create;
    const openFileTab = vi.spyOn(useEditorStore.getState(), "openFileTab").mockResolvedValue(true);

    await expect(createExplorerEntry(PROJECT, "src", "new.ts", "file")).resolves.toBe(true);

    expect(create).toHaveBeenCalledWith({ projectPath: PROJECT, path: "src/new.ts", kind: "file" });
    expect(openFileTab).toHaveBeenCalledWith(PROJECT, "src/new.ts");
    expect(useAppStore.getState().hint).toMatch(/Created new\.ts/);
  });

  it("rejects an invalid name before calling main", async () => {
    const { bridge } = installBridge();
    const create = vi.fn();
    (bridge.workspace as unknown as { create: unknown }).create = create;

    await expect(createExplorerEntry(PROJECT, "src", "CON", "file")).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(useAppStore.getState().hint).toMatch(/not valid/);
  });
});

describe("explorer rename/delete", () => {
  it("renames, retargets editor tabs and refreshes the parent", async () => {
    const { bridge } = installBridge();
    const rename = vi.fn(async () =>
      ok({
        path: "src/renamed.ts",
        absolutePath: "C:\\work\\app\\src\\renamed.ts",
        kind: "file" as const,
        previousPath: "src/a.ts",
      }),
    );
    const retarget = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.workspace as unknown as { rename: unknown }).rename = rename;
    (bridge.sessions as unknown as { retargetEditorTabs: unknown }).retargetEditorTabs = retarget;
    const retargetPaths = vi.spyOn(useEditorStore.getState(), "retargetEditorPaths");

    await expect(renameExplorerEntry(PROJECT, "src/a.ts", "renamed.ts")).resolves.toBe(true);

    expect(rename).toHaveBeenCalledWith({
      projectPath: PROJECT,
      path: "src/a.ts",
      toPath: "src/renamed.ts",
    });
    expect(retarget).toHaveBeenCalledWith({
      fromProjectPath: PROJECT,
      fromPath: "src/a.ts",
      toProjectPath: PROJECT,
      toPath: "src/renamed.ts",
      kind: "file",
    });
    expect(retargetPaths).toHaveBeenCalled();
  });

  it("deletes after dirty resolution and closes affected editor tabs", async () => {
    const { bridge } = installBridge();
    const deleteEntry = vi.fn(async () =>
      ok({ path: "src/a.ts", absolutePath: "C:\\work\\app\\src\\a.ts", kind: "file" as const }),
    );
    const close = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.workspace as unknown as { delete: unknown }).delete = deleteEntry;
    (bridge.sessions as unknown as { close: unknown }).close = close;
    useAppStore.setState({
      tabs: [
        {
          id: "editor-1",
          kind: "editor",
          cwd: PROJECT,
          title: "a.ts",
          sessionFile: null,
          status: "idle",
          createdAt: 1,
          lastActiveAt: 1,
          model: null,
          filePath: "src/a.ts",
        },
      ],
      activeTabId: "editor-1",
    });

    await expect(deleteExplorerEntry(PROJECT, "src/a.ts", "file")).resolves.toBe(true);

    expect(deleteEntry).toHaveBeenCalledWith({ projectPath: PROJECT, path: "src/a.ts" });
    expect(close).toHaveBeenCalledWith("editor-1");
  });

  it("does not delete when the dirty prompt is cancelled", async () => {
    const { bridge } = installBridge();
    const deleteEntry = vi.fn();
    (bridge.workspace as unknown as { delete: unknown }).delete = deleteEntry;
    useEditorStore.setState({
      meta: {
        "editor-1": {
          tabId: "editor-1",
          projectPath: PROJECT,
          path: "src/a.ts",
          languageId: "typescript",
          loading: false,
          error: null,
          dirty: true,
          readOnly: false,
          binary: false,
          encoding: "utf8",
          eol: "lf",
          bom: false,
          size: 1,
          mtimeMs: 1,
          line: 1,
          column: 1,
          selectionLength: 0,
          externalChange: null,
          recovered: false,
        },
      },
    });
    useAppStore.setState({
      tabs: [
        {
          id: "editor-1",
          kind: "editor",
          cwd: PROJECT,
          title: "a.ts",
          sessionFile: null,
          status: "idle",
          createdAt: 1,
          lastActiveAt: 1,
          model: null,
          filePath: "src/a.ts",
        },
      ],
    });

    const deleting = deleteExplorerEntry(PROJECT, "src/a.ts", "file");
    await vi.waitFor(() => expect(useEditorStore.getState().pendingClose).not.toBeNull());
    await useEditorStore.getState().answerClose("cancel");
    await expect(deleting).resolves.toBe(false);
    expect(deleteEntry).not.toHaveBeenCalled();
  });
});

describe("explorer paste/reveal", () => {
  it("copies and keeps the clipboard", async () => {
    const { bridge } = installBridge();
    const transfer = vi.fn(async () =>
      ok({
        operation: "copy" as const,
        transferred: [{ sourcePath: "a.ts", targetPath: "src/a.ts", kind: "file" as const }],
      }),
    );
    (bridge.workspace as unknown as { transfer: unknown }).transfer = transfer;
    useFileClipboardStore.getState().copy(PROJECT, ["a.ts"]);

    await expect(pasteExplorerEntries(PROJECT, "src")).resolves.toBe(true);

    expect(transfer).toHaveBeenCalledWith({
      sourceProjectPath: PROJECT,
      targetProjectPath: PROJECT,
      sources: ["a.ts"],
      targetDirectory: "src",
      operation: "copy",
    });
    expect(useFileClipboardStore.getState().clipboard).not.toBeNull();
  });

  it("moves, retargets tabs and clears the clipboard", async () => {
    const { bridge } = installBridge();
    const transfer = vi.fn(async () =>
      ok({
        operation: "move" as const,
        transferred: [{ sourcePath: "a.ts", targetPath: "src/a.ts", kind: "file" as const }],
      }),
    );
    const retarget = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.workspace as unknown as { transfer: unknown }).transfer = transfer;
    (bridge.sessions as unknown as { retargetEditorTabs: unknown }).retargetEditorTabs = retarget;
    useFileClipboardStore.getState().cut(PROJECT, ["a.ts"]);

    await expect(pasteExplorerEntries(PROJECT, "src")).resolves.toBe(true);

    expect(retarget).toHaveBeenCalled();
    expect(useFileClipboardStore.getState().clipboard).toBeNull();
  });

  it("reveals a path through the workspace bridge", async () => {
    const { bridge } = installBridge();
    const reveal = vi.fn(async () => ok(true));
    (bridge.workspace as unknown as { reveal: unknown }).reveal = reveal;
    await expect(revealExplorerPath(PROJECT, "a.ts")).resolves.toBe(true);
    expect(reveal).toHaveBeenCalledWith({ projectPath: PROJECT, path: "a.ts" });
  });
});
