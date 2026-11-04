import { beforeEach, describe, expect, it, vi } from "vitest";

import { useEditorStore } from "../../src/renderer/src/editor/editor-store";
import { getBuffer, setBufferText } from "../../src/renderer/src/editor/buffer-registry";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import type { TabRecord } from "../../src/shared/session-ipc";
import type { WorkspaceFileContent } from "../../src/shared/workspace";
import { installBridge } from "./fixtures";

/**
 * Editor save/format store behaviour (2026-11-02 plan step 3).
 *
 * Ctrl+S is repeatable, so two presses must not send two writes with the same
 * expected mtime (the second would report a false conflict). A thrown write
 * becomes the editor's inline error instead of an unhandled rejection, and a
 * read-only buffer never reaches the formatter.
 */

const WORK = "C:\\work\\pi-desktop";
const TAB = "editor-1";

function editorTab(): TabRecord {
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
  };
}

const WRITE_RESULT = {
  ok: true as const,
  value: { path: `${WORK}\\a.ts`, relativePath: "a.ts", size: 8, mtimeMs: 2, bytes: 8 },
};

function meta(tabId: string, path: string, dirty = false) {
  return {
    tabId,
    projectPath: WORK,
    path,
    languageId: "typescript" as const,
    loading: false,
    error: null,
    dirty,
    readOnly: false,
    binary: false,
    encoding: "utf8" as const,
    eol: "lf" as const,
    bom: false,
    size: 1,
    mtimeMs: 1,
    line: 1,
    column: 1,
    selectionLength: 0,
    externalChange: null,
    recovered: false,
  };
}

async function seed(writeFile: ReturnType<typeof vi.fn>): Promise<void> {
  const { bridge } = installBridge();
  (bridge.workspace as unknown as { readFile: unknown }).readFile = vi.fn(async () => ({
    ok: true as const,
    value: {
      path: `${WORK}\\a.ts`,
      relativePath: "a.ts",
      kind: "text" as const,
      text: "let a=1;",
      bytes: 8,
      size: 8,
      mtimeMs: 1,
      truncated: false,
      eol: "lf" as const,
      bom: false,
      encoding: "utf8" as const,
    },
  }));
  (bridge.workspace as unknown as { writeFile: unknown }).writeFile = writeFile;
  useAppStore.setState({ tabs: [editorTab()], activeTabId: TAB });
  await useEditorStore.getState().load(TAB);
}

beforeEach(() => {
  useEditorStore.getState().clearExcept(new Set());
  useEditorStore.setState({ pendingClose: null });
  useAppStore.setState({ tabs: [], activeTabId: null, hint: null });
});

describe("editor save coalescing", () => {
  it("returns the in-flight save for a repeated Ctrl+S and writes once", async () => {
    let resolveWrite: ((value: unknown) => void) | undefined;
    const writeFile = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve;
        }),
    );
    await seed(writeFile);

    const first = useEditorStore.getState().save(TAB);
    const second = useEditorStore.getState().save(TAB);

    expect(second).toBe(first);
    expect(writeFile).toHaveBeenCalledTimes(1);

    resolveWrite?.(WRITE_RESULT);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(useEditorStore.getState().meta[TAB]?.dirty).toBe(false);
  });

  it("surfaces a thrown write as the editor's inline error", async () => {
    const writeFile = vi.fn(async () => {
      throw new Error("disk full");
    });
    await seed(writeFile);

    await expect(useEditorStore.getState().save(TAB)).resolves.toBe(false);
    expect(useEditorStore.getState().meta[TAB]?.error).toMatch(/disk full/);
  });
});

describe("editor format guard", () => {
  it("refuses a read-only buffer before calling the formatter", async () => {
    const writeFile = vi.fn(async () => WRITE_RESULT);
    await seed(writeFile);
    const { bridge } = installBridge();
    const format = vi.fn(async () => ({ ok: true as const, value: { text: "let a = 1;\n" } }));
    (bridge.workspace as unknown as { format: unknown }).format = format;

    const meta = useEditorStore.getState().meta[TAB];
    expect(meta).toBeDefined();
    useEditorStore.setState({
      meta: { ...useEditorStore.getState().meta, [TAB]: { ...meta!, readOnly: true } },
    });

    await expect(useEditorStore.getState().format(TAB)).resolves.toBe(false);
    expect(format).not.toHaveBeenCalled();
  });
});

describe("dirty batch resolution", () => {
  it("prompts each dirty tab and cancels the rest", async () => {
    installBridge();
    useEditorStore.setState({
      meta: {
        "editor-1": meta("editor-1", "a.ts", true),
        "editor-2": meta("editor-2", "b.ts", true),
      },
    });

    const resolving = useEditorStore
      .getState()
      .resolveDirtyTabs(["editor-1", "editor-2"], "close-all");
    await vi.waitFor(() => expect(useEditorStore.getState().pendingClose).not.toBeNull());
    expect(useEditorStore.getState().pendingClose).toMatchObject({
      tabId: "editor-1",
      remaining: 2,
      reason: "close-all",
    });

    await useEditorStore.getState().answerClose("discard");
    await vi.waitFor(() =>
      expect(useEditorStore.getState().pendingClose).toMatchObject({
        tabId: "editor-2",
        remaining: 1,
      }),
    );
    await useEditorStore.getState().answerClose("cancel");

    await expect(resolving).resolves.toBe(false);
    expect(useEditorStore.getState().meta["editor-1"]).toBeUndefined();
    expect(useEditorStore.getState().meta["editor-2"]).toBeDefined();
  });

  it("returns true immediately for clean tabs", async () => {
    installBridge();
    useEditorStore.setState({ meta: { "editor-1": meta("editor-1", "a.ts") } });
    await expect(useEditorStore.getState().resolveDirtyTabs(["editor-1"], "close")).resolves.toBe(
      true,
    );
    expect(useEditorStore.getState().meta["editor-1"]).toBeDefined();
  });
});

describe("editor tab retargeting and pruning", () => {
  it("retargets matching metadata and leaves unrelated tabs alone", () => {
    useEditorStore.setState({
      meta: {
        "editor-1": meta("editor-1", "src/app.ts"),
        "editor-2": meta("editor-2", "other.ts"),
      },
    });

    const changed = useEditorStore.getState().retargetEditorPaths({
      fromProjectPath: WORK,
      fromPath: "src",
      toProjectPath: WORK,
      toPath: "lib",
      kind: "directory",
    });

    expect(changed).toEqual(["editor-1"]);
    expect(useEditorStore.getState().meta["editor-1"]).toMatchObject({
      path: "lib/app.ts",
      projectPath: WORK,
    });
    expect(useEditorStore.getState().meta["editor-2"]?.path).toBe("other.ts");
  });

  it("prunes metadata and deletes its backup for a closed tab", async () => {
    const { bridge } = installBridge();
    const deleteBackup = vi.fn(async () => ({ ok: true as const, value: true }));
    (bridge.workspace as unknown as { deleteBackup: unknown }).deleteBackup = deleteBackup;
    useEditorStore.setState({
      meta: {
        "editor-1": meta("editor-1", "a.ts"),
        "editor-2": meta("editor-2", "b.ts"),
      },
    });

    await useEditorStore.getState().prune(new Set(["editor-1"]));

    expect(useEditorStore.getState().meta["editor-1"]).toBeDefined();
    expect(useEditorStore.getState().meta["editor-2"]).toBeUndefined();
    expect(deleteBackup).toHaveBeenCalledWith("editor-2");
  });
});

/** One text file in the fixture workspace, with the fields the store reads. */
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

function statFile(mtimeMs: number, size = 8) {
  return {
    ok: true as const,
    value: {
      path: `${WORK}\\a.ts`,
      relativePath: "a.ts",
      kind: "file" as const,
      size,
      mtimeMs,
    },
  };
}

/** The two shapes the load path has to handle from `workspace.readFile`. */
type ReadResult =
  | { ok: true; value: WorkspaceFileContent }
  | { ok: false; error: { code: string; message: string } };

/** Install the bridge and replace the workspace reads the load path uses. */
function installWorkspace() {
  const { bridge } = installBridge();
  const workspace = bridge.workspace as unknown as Record<string, unknown>;
  const readFile = vi.fn<() => Promise<ReadResult>>(async () => textFile("one"));
  const readBackup = vi.fn(async () => ({ ok: true as const, value: null }));
  const deleteBackup = vi.fn(async () => ({ ok: true as const, value: true }));
  const stat = vi.fn(async () => statFile(1));
  workspace.readFile = readFile;
  workspace.readBackup = readBackup;
  workspace.deleteBackup = deleteBackup;
  workspace.stat = stat;
  useAppStore.setState({ tabs: [editorTab()], activeTabId: TAB });
  return { readFile, readBackup, deleteBackup, stat };
}

describe("editor load", () => {
  it("coalesces concurrent reads for one tab", async () => {
    const ws = installWorkspace();
    let release: (() => void) | undefined;
    ws.readFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(textFile("one"));
        }),
    );

    const first = useEditorStore.getState().load(TAB);
    const second = useEditorStore.getState().load(TAB);

    expect(second).toBe(first);
    expect(ws.readFile).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.all([first, second]);
    expect(getBuffer(TAB)?.text).toBe("one");
  });

  it("never overwrites a dirty buffer with the disk copy", async () => {
    const ws = installWorkspace();
    await useEditorStore.getState().load(TAB);
    const loaded = useEditorStore.getState().meta[TAB]!;
    useEditorStore.setState({
      meta: { ...useEditorStore.getState().meta, [TAB]: { ...loaded, dirty: true } },
    });
    setBufferText(TAB, "local edit");
    ws.readFile.mockResolvedValue(textFile("disk changed", { mtimeMs: 9 }));
    ws.stat.mockResolvedValue(statFile(9, 12));

    await useEditorStore.getState().load(TAB);

    expect(ws.readFile).toHaveBeenCalledTimes(1);
    expect(getBuffer(TAB)?.text).toBe("local edit");
    expect(useEditorStore.getState().meta[TAB]?.externalChange).toEqual({
      mtimeMs: 9,
      size: 12,
    });
  });

  it("reports a refresh as loading without losing the buffer", async () => {
    const ws = installWorkspace();
    await useEditorStore.getState().load(TAB);
    ws.readFile.mockResolvedValue(textFile("two", { mtimeMs: 2 }));

    const run = useEditorStore.getState().load(TAB);
    expect(useEditorStore.getState().meta[TAB]?.loading).toBe(true);
    expect(getBuffer(TAB)?.text).toBe("one");
    await run;

    expect(getBuffer(TAB)?.text).toBe("two");
    expect(useEditorStore.getState().meta[TAB]?.loading).toBe(false);
  });

  it("forces the disk copy over a dirty buffer and drops the backup", async () => {
    const ws = installWorkspace();
    await useEditorStore.getState().load(TAB);
    const loaded = useEditorStore.getState().meta[TAB]!;
    useEditorStore.setState({
      meta: { ...useEditorStore.getState().meta, [TAB]: { ...loaded, dirty: true } },
    });
    setBufferText(TAB, "local edit");
    ws.readFile.mockResolvedValue(textFile("disk", { mtimeMs: 7 }));

    await useEditorStore.getState().load(TAB, { force: true });

    expect(getBuffer(TAB)?.text).toBe("disk");
    expect(useEditorStore.getState().meta[TAB]?.dirty).toBe(false);
    expect(ws.deleteBackup).toHaveBeenCalledWith(TAB);
    // A forced reload ignores the backup; only the first load read it.
    expect(ws.readBackup).toHaveBeenCalledTimes(1);
  });

  it("keeps the buffer when a refresh fails", async () => {
    const ws = installWorkspace();
    await useEditorStore.getState().load(TAB);
    ws.readFile.mockResolvedValue({
      ok: false as const,
      error: { code: "not_found" as const, message: "gone" },
    });

    await useEditorStore.getState().load(TAB);

    expect(getBuffer(TAB)?.text).toBe("one");
    expect(useEditorStore.getState().meta[TAB]?.error).toBe("gone");
  });
});
