/**
 * Editor-tab state (metadata only; the text lives in `buffer-registry`).
 *
 * A separate zustand store keeps the 6 000-line app store from growing another
 * slice and keeps the editor's re-render surface small. The tab table itself
 * still comes from the app store — editor tabs are ordinary tabs with
 * `kind: "editor"`.
 */

import { create } from "zustand";

import {
  isEditorTab,
  type RetargetEditorTabsInput,
  type TabRecord,
} from "../../../shared/session-ipc";
import {
  MAX_EDITOR_WRITE_BYTES,
  isWorkspacePathWithin,
  type FileEncoding,
  type FileEol,
  type WorkspaceFileContent,
} from "../../../shared/workspace";
import { languageIdForPath, type LanguageId } from "../../../shared/languages";
import { sameFolder } from "../../../shared/rail-scope";
import { useAppStore } from "../state/app-store";
import {
  getBuffer,
  putBuffer,
  removeBuffer,
  setBufferText,
  updateBufferBaseline,
  updateBufferPath,
} from "./buffer-registry";
import { editorView } from "./editor-registry";

export interface EditorMeta {
  tabId: string;
  projectPath: string;
  path: string;
  languageId: LanguageId;
  loading: boolean;
  error: string | null;
  dirty: boolean;
  readOnly: boolean;
  binary: boolean;
  encoding: FileEncoding;
  eol: FileEol;
  bom: boolean;
  size: number;
  mtimeMs: number | null;
  line: number;
  column: number;
  selectionLength: number;
  externalChange: { mtimeMs: number; size: number } | null;
  recovered: boolean;
}

export type EditorCloseReason =
  "close" | "close-others" | "close-all" | "delete" | "remove-project";

export interface PendingEditorClose {
  tabId: string;
  /** Dirty tabs left in this batch, including this one. */
  remaining: number;
  reason: EditorCloseReason;
}

interface EditorStore {
  meta: Record<string, EditorMeta>;
  /** The tab a close prompt is waiting on, or null. */
  pendingClose: PendingEditorClose | null;
  requestClose(tabId: string): void;
  /** Resolves every dirty tab in order; false means the user cancelled. */
  resolveDirtyTabs(tabIds: readonly string[], reason: EditorCloseReason): Promise<boolean>;
  /** Resolves dirty tabs, then closes all of them. */
  requestCloseTabs(tabIds: readonly string[], reason: EditorCloseReason): Promise<boolean>;
  answerClose(decision: "save" | "discard" | "cancel"): Promise<void>;
  openFileTab(projectPath: string, path: string): Promise<boolean>;
  load(tabId: string): Promise<void>;
  save(tabId: string, options?: { force?: boolean }): Promise<boolean>;
  discard(tabId: string): Promise<void>;
  format(tabId: string): Promise<boolean>;
  setDirty(tabId: string, dirty: boolean): void;
  setPosition(
    tabId: string,
    position: { line: number; column: number; selectionLength: number },
  ): void;
  setText(tabId: string, text: string): void;
  scheduleBackup(tabId: string): void;
  flushBackups(): Promise<void>;
  checkExternalChange(tabId: string): Promise<void>;
  reload(tabId: string): Promise<void>;
  /** Keeps open editor tabs pointing at the right file after a rename/move. */
  retargetEditorPaths(input: RetargetEditorTabsInput): string[];
  /** Drops metadata/buffers/backups for tabs no longer in app state. */
  prune(openTabIds: ReadonlySet<string>): Promise<void>;
  clearExcept(tabIds: ReadonlySet<string>): void;
}

const backupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const backupRuns = new Set<Promise<unknown>>();
/** In-flight saves, so a repeated Ctrl+S writes once and keeps one baseline. */
const saveRuns = new Map<string, Promise<boolean>>();
/** Resolver for the currently displayed close prompt, if any. */
let pendingCloseResolver: ((ok: boolean) => void) | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureMessage(result: { ok: false; error: { message: string } }): string {
  return result.error.message;
}

function tabFor(tabId: string): TabRecord | undefined {
  return useAppStore.getState().tabs.find((tab) => tab.id === tabId);
}

function buildEditorMeta(
  tabId: string,
  projectPath: string,
  filePath: string,
  content: WorkspaceFileContent | null,
  overrides: Partial<EditorMeta> = {},
): EditorMeta {
  return {
    tabId,
    projectPath,
    path: filePath,
    languageId: languageIdForPath(filePath),
    loading: false,
    error: content === null ? "The file could not be read." : null,
    dirty: false,
    readOnly: true,
    binary: false,
    encoding: "utf8",
    eol: "lf",
    bom: false,
    size: 0,
    mtimeMs: null,
    line: 1,
    column: 1,
    selectionLength: 0,
    externalChange: null,
    recovered: false,
    ...overrides,
  };
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  meta: {},
  pendingClose: null,

  requestClose(tabId) {
    void (async () => {
      const ok = await get().resolveDirtyTabs([tabId], "close");
      if (ok) await useAppStore.getState().closeTab(tabId);
    })();
  },

  async resolveDirtyTabs(tabIds, reason) {
    if (pendingCloseResolver) return false;
    const dirty = tabIds.filter((tabId) => get().meta[tabId]?.dirty === true);
    for (let index = 0; index < dirty.length; index += 1) {
      const tabId = dirty[index]!;
      const ok = await new Promise<boolean>((resolve) => {
        pendingCloseResolver = resolve;
        set({
          pendingClose: { tabId, remaining: dirty.length - index, reason },
        });
      });
      if (!ok) return false;
    }
    return true;
  },

  async requestCloseTabs(tabIds, reason) {
    if (!(await get().resolveDirtyTabs(tabIds, reason))) return false;
    for (const tabId of tabIds) await useAppStore.getState().closeTab(tabId);
    return true;
  },

  async answerClose(decision) {
    const pending = get().pendingClose;
    const resolve = pendingCloseResolver;
    if (pending === null) return;
    if (decision === "cancel") {
      pendingCloseResolver = null;
      set({ pendingClose: null });
      resolve?.(false);
      return;
    }
    if (decision === "save") {
      const saved = await get().save(pending.tabId);
      if (!saved) return;
    } else {
      await get().discard(pending.tabId);
    }
    pendingCloseResolver = null;
    set({ pendingClose: null });
    resolve?.(true);
  },

  async openFileTab(projectPath, path) {
    const app = useAppStore.getState();
    const existing = app.tabs.find(
      (tab) => isEditorTab(tab) && tab.cwd === projectPath && tab.filePath === path,
    );
    if (existing) {
      await app.activateTab(existing.id);
      await get().load(existing.id);
      return true;
    }
    const api = window.pi;
    if (!api?.sessions) {
      useAppStore.getState().setHint("The preload bridge is unavailable.");
      return false;
    }
    try {
      const envelope = await api.sessions.create({
        cwd: projectPath,
        kind: "editor",
        filePath: path,
      });
      useAppStore.getState().applyTabs(envelope);
      useAppStore.getState().setView("session");
      const active = envelope.activeTabId;
      if (active) await get().load(active);
      return true;
    } catch (error) {
      useAppStore.getState().setHint(errorMessage(error));
      return false;
    }
  },

  async load(tabId) {
    const tab = tabFor(tabId);
    if (!tab || !isEditorTab(tab)) return;
    const api = window.pi;
    if (!api?.workspace) {
      set((state) => ({
        meta: {
          ...state.meta,
          [tabId]: buildEditorMeta(tab.id, tab.cwd, tab.filePath, null, {
            error: "The preload bridge is unavailable.",
          }),
        },
      }));
      return;
    }
    set((state) => ({
      meta: {
        ...state.meta,
        [tabId]: state.meta[tabId]
          ? { ...state.meta[tabId], loading: true, error: null }
          : buildEditorMeta(tab.id, tab.cwd, tab.filePath, null, { loading: true }),
      },
    }));

    const [file, backup] = await Promise.all([
      api.workspace.readFile({ projectPath: tab.cwd, path: tab.filePath }),
      api.workspace.readBackup(tabId),
    ]);
    if (!file.ok) {
      set((state) => ({
        meta: {
          ...state.meta,
          [tabId]: buildEditorMeta(tab.id, tab.cwd, tab.filePath, null, {
            error: failureMessage(file),
          }),
        },
      }));
      return;
    }
    const content = file.value;
    const recovered =
      backup.ok && backup.value !== null && backup.value.text !== (content.text ?? "")
        ? backup.value
        : null;
    const text = recovered ? recovered.text : (content.text ?? "");
    const readOnly =
      content.kind !== "text" ||
      content.truncated ||
      content.size > MAX_EDITOR_WRITE_BYTES ||
      (recovered === null && content.size > MAX_EDITOR_WRITE_BYTES);

    putBuffer({
      tabId,
      projectPath: tab.cwd,
      path: tab.filePath,
      text,
      baselineMtimeMs: content.mtimeMs,
      eol: content.eol,
      bom: content.bom,
      readOnly,
    });
    set((state) => ({
      meta: {
        ...state.meta,
        [tabId]: buildEditorMeta(tab.id, tab.cwd, tab.filePath, content, {
          dirty: recovered !== null,
          readOnly,
          binary: content.kind === "binary",
          encoding: content.encoding,
          eol: content.eol,
          bom: content.bom,
          size: content.size,
          mtimeMs: content.mtimeMs,
          recovered: recovered !== null,
          error:
            content.kind === "text"
              ? null
              : content.kind === "binary"
                ? "Binary file: preview is not available."
                : content.kind === "too_large"
                  ? "File is too large to edit."
                  : "UTF-16 files are not editable; open it externally.",
        }),
      },
    }));
  },

  save(tabId, options = {}) {
    // Ctrl+S is repeatable: a second press while the first write is in flight
    // reuses that promise. Two writes would both send the old baseline, and the
    // second would then look like an external change (a false conflict).
    const running = saveRuns.get(tabId);
    if (running) return running;

    const run = (async (): Promise<boolean> => {
      const buffer = getBuffer(tabId);
      const meta = get().meta[tabId];
      if (!buffer || !meta || meta.readOnly || meta.binary) return false;
      const api = window.pi;
      if (!api?.workspace) return false;
      try {
        const result = await api.workspace.writeFile({
          projectPath: buffer.projectPath,
          path: buffer.path,
          text: buffer.text,
          eol: buffer.eol,
          bom: buffer.bom,
          expectedMtimeMs: buffer.baselineMtimeMs,
          ...(options.force ? { force: true } : {}),
        });
        if (!result.ok) {
          set((state) => ({
            meta: {
              ...state.meta,
              [tabId]: {
                ...meta,
                error: failureMessage(result),
                externalChange:
                  result.error.code === "conflict"
                    ? (result.error.current ?? null)
                    : meta.externalChange,
              },
            },
          }));
          return false;
        }
        updateBufferBaseline(tabId, result.value.mtimeMs);
        await api.workspace.deleteBackup(tabId).catch(() => undefined);
        set((state) => ({
          meta: {
            ...state.meta,
            [tabId]: {
              ...meta,
              dirty: false,
              error: null,
              externalChange: null,
              recovered: false,
              mtimeMs: result.value.mtimeMs,
              size: result.value.size,
            },
          },
        }));
        void useAppStore.getState().loadGit(buffer.projectPath);
        return true;
      } catch (error) {
        set((state) => ({
          meta: { ...state.meta, [tabId]: { ...meta, error: errorMessage(error) } },
        }));
        return false;
      }
    })();

    saveRuns.set(tabId, run);
    void run
      .finally(() => {
        if (saveRuns.get(tabId) === run) saveRuns.delete(tabId);
      })
      .catch(() => undefined);
    return run;
  },

  async format(tabId) {
    const buffer = getBuffer(tabId);
    const meta = get().meta[tabId];
    const api = window.pi;
    if (!buffer || !meta || meta.readOnly || meta.binary || !api?.workspace) return false;
    const result = await api.workspace.format({
      projectPath: buffer.projectPath,
      path: buffer.path,
      languageId: meta.languageId,
      text: buffer.text,
    });
    if (!result.ok) {
      set((state) => ({
        meta: { ...state.meta, [tabId]: { ...meta, error: result.error.message } },
      }));
      return false;
    }
    const view = editorView(tabId);
    if (view) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: result.value.text },
      });
    }
    setBufferText(tabId, result.value.text);
    get().setDirty(tabId, true);
    return true;
  },

  async discard(tabId) {
    removeBuffer(tabId);
    if (window.pi?.workspace) await window.pi.workspace.deleteBackup(tabId).catch(() => undefined);
    set((state) => {
      const next = { ...state.meta };
      delete next[tabId];
      return { meta: next };
    });
  },

  retargetEditorPaths(input) {
    const next = { ...get().meta };
    const changed: string[] = [];
    for (const [tabId, meta] of Object.entries(next)) {
      if (!sameFolder(meta.projectPath, input.fromProjectPath)) continue;
      if (!isWorkspacePathWithin(meta.path, input.fromPath, input.kind)) continue;
      const suffix = input.kind === "file" ? "" : meta.path.slice(input.fromPath.length);
      const path = `${input.toPath}${suffix}`;
      next[tabId] = {
        ...meta,
        projectPath: input.toProjectPath,
        path,
        languageId: languageIdForPath(path),
      };
      updateBufferPath(tabId, input.toProjectPath, path);
      changed.push(tabId);
    }
    if (changed.length > 0) set({ meta: next });
    return changed;
  },

  async prune(openTabIds) {
    for (const tabId of Object.keys(get().meta)) {
      if (!openTabIds.has(tabId)) await get().discard(tabId);
    }
  },

  setDirty(tabId, dirty) {
    set((state) => {
      const meta = state.meta[tabId];
      return meta ? { meta: { ...state.meta, [tabId]: { ...meta, dirty } } } : state;
    });
  },

  setPosition(tabId, position) {
    set((state) => {
      const meta = state.meta[tabId];
      return meta ? { meta: { ...state.meta, [tabId]: { ...meta, ...position } } } : state;
    });
  },

  setText(tabId, text) {
    setBufferText(tabId, text);
    get().setDirty(tabId, true);
    get().scheduleBackup(tabId);
  },

  scheduleBackup(tabId) {
    const existing = backupTimers.get(tabId);
    if (existing) clearTimeout(existing);
    backupTimers.set(
      tabId,
      setTimeout(() => {
        backupTimers.delete(tabId);
        const buffer = getBuffer(tabId);
        const meta = get().meta[tabId];
        if (!buffer || !meta || !meta.dirty || !window.pi?.workspace) return;
        const run = window.pi.workspace
          .writeBackup({
            version: 1,
            tabId,
            projectPath: buffer.projectPath,
            path: buffer.path,
            text: buffer.text,
            updatedAt: Date.now(),
            baselineMtimeMs: buffer.baselineMtimeMs,
            eol: buffer.eol,
            bom: buffer.bom,
          })
          .catch(() => undefined);
        backupRuns.add(run);
        void run.finally(() => backupRuns.delete(run));
      }, 500),
    );
  },

  async flushBackups() {
    for (const [tabId, timer] of backupTimers) {
      clearTimeout(timer);
      backupTimers.delete(tabId);
      const buffer = getBuffer(tabId);
      const meta = get().meta[tabId];
      if (!buffer || !meta?.dirty || !window.pi?.workspace) continue;
      await window.pi.workspace.writeBackup({
        version: 1,
        tabId,
        projectPath: buffer.projectPath,
        path: buffer.path,
        text: buffer.text,
        updatedAt: Date.now(),
        baselineMtimeMs: buffer.baselineMtimeMs,
        eol: buffer.eol,
        bom: buffer.bom,
      });
    }
    await Promise.all([...backupRuns]);
  },

  async checkExternalChange(tabId) {
    const buffer = getBuffer(tabId);
    const meta = get().meta[tabId];
    if (!buffer || !meta || !window.pi?.workspace) return;
    const result = await window.pi.workspace.stat({
      projectPath: buffer.projectPath,
      path: buffer.path,
    });
    if (!result.ok || result.value.kind !== "file") return;
    if (
      buffer.baselineMtimeMs !== null &&
      Math.abs(result.value.mtimeMs - buffer.baselineMtimeMs) <= 1
    ) {
      return;
    }
    if (!meta.dirty) {
      await get().load(tabId);
      return;
    }
    set((state) => ({
      meta: {
        ...state.meta,
        [tabId]: {
          ...meta,
          externalChange: { mtimeMs: result.value.mtimeMs, size: result.value.size },
        },
      },
    }));
  },

  async reload(tabId) {
    await get().load(tabId);
  },

  clearExcept(tabIds) {
    set((state) => {
      const next: Record<string, EditorMeta> = {};
      for (const [tabId, meta] of Object.entries(state.meta)) {
        if (tabIds.has(tabId)) next[tabId] = meta;
        else {
          removeBuffer(tabId);
          const timer = backupTimers.get(tabId);
          if (timer) clearTimeout(timer);
          backupTimers.delete(tabId);
        }
      }
      return { meta: next };
    });
  },
}));

/**
 * The tab table is the authority on which editor tabs still exist. Pruning here
 * (rather than in app-store) avoids a store import cycle and fixes close paths
 * that do not go through the editor's own close prompt.
 */
let lastOpenTabIds: string | null = null;
useAppStore.subscribe((state) => {
  const ids = state.tabs
    .map((tab) => tab.id)
    .sort()
    .join("\u0000");
  if (ids === lastOpenTabIds) return;
  lastOpenTabIds = ids;
  void useEditorStore.getState().prune(new Set(state.tabs.map((tab) => tab.id)));
});
