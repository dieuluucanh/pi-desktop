import { beforeEach, describe, expect, it, vi } from "vitest";

import { useEditorStore } from "../../src/renderer/src/editor/editor-store";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import type { TabRecord } from "../../src/shared/session-ipc";
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
