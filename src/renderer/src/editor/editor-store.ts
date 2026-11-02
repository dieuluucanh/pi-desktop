/**
 * Editor-tab state (metadata only; the text lives in `buffer-registry`).
 *
 * A separate zustand store keeps the 6 000-line app store from growing another
 * slice and keeps the editor's re-render surface small. The tab table itself
 * still comes from the app store — editor tabs are ordinary tabs with
 * `kind: "editor"`.
 */

import { create } from "zustand";

import { isEditorTab, type TabRecord } from "../../../shared/session-ipc";
import {
  MAX_EDITOR_WRITE_BYTES,
  type FileEncoding,
  type FileEol,
  type WorkspaceFileContent,
} from "../../../shared/workspace";
import { languageIdForPath, type LanguageId } from "../../../shared/languages";
import { useAppStore } from "../state/app-store";
import {
  getBuffer,
  putBuffer,
  removeBuffer,
  setBufferText,
  updateBufferBaseline,
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

interface EditorStore {
  meta: Record<string, EditorMeta>;
  /** The tab a close prompt is waiting on, or null. */
  pendingClose: string | null;
  requestClose(tabId: string): void;
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
  clearExcept(tabIds: ReadonlySet<string>): void;
}

const backupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const backupRuns = new Set<Promise<unknown>>();
/** In-flight saves, so a repeated Ctrl+S writes once and keeps one baseline. */
const saveRuns = new Map<string, Promise<boolean>>();

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
    if (get().meta[tabId]?.dirty) {
      set({ pendingClose: tabId });
      return;
    }
    void useAppStore.getState().closeTab(tabId);
  },

  async answerClose(decision) {
    const tabId = get().pendingClose;
    if (tabId === null) return;
    if (decision === "cancel") {
      set({ pendingClose: null });
      return;
    }
    if (decision === "save") {
      const saved = await get().save(tabId);
      if (!saved) return;
    } else {
      await get().discard(tabId);
    }
    set({ pendingClose: null });
    await useAppStore.getState().closeTab(tabId);
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
