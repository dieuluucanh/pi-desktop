import { create } from "zustand";
import type { AppInfo } from "../../../shared/ipc";
import { DEFAULT_PREFS, type UiPrefs } from "../../../shared/prefs";
import type {
  SessionEventEnvelope,
  SessionStateEnvelope,
  SessionTabsEnvelope,
  TabRecord,
} from "../../../shared/session-ipc";
import {
  createTranscriptState,
  hydrateMessages,
  reduceSessionEvents,
  type TranscriptState,
} from "../session/session-events";

/**
 * The renderer's view state (plan step 1).
 *
 * Two rules keep this predictable:
 *  - the store never talks to a Pi host (that is the session service, step 3);
 *  - preferences are the only thing persisted, through the `prefs.*` IPC, so the
 *    main process stays the single writer of `app-state.json`.
 *
 * Projects and tabs are in-memory here and become persistent in step 10/11.
 */

export type AppView =
  | "welcome"
  | "session"
  | "settings"
  | "extensions"
  | "connections"
  | "skills"
  | "diagnostics"
  | "office";

/** How a message sent while the agent is streaming is delivered (plan step 6). */
export type SendMode = "steer" | "followUp";

/** One image attachment ready for `prompt`'s `images` parameter. */
export interface PromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * The composer's draft/persist debounce. Writing app state on every keystroke
 * would hammer the disk; the draft is safe in memory immediately and lands in
 * `app-state.json` shortly after the user stops typing.
 */
let draftPersistTimer: ReturnType<typeof setTimeout> | null = null;
export const DRAFT_PERSIST_DELAY_MS = 500;

export const APP_VIEWS: readonly AppView[] = [
  "welcome",
  "session",
  "settings",
  "extensions",
  "connections",
  "skills",
  "diagnostics",
  "office",
];

export interface ProjectRef {
  path: string;
  name: string;
}

export interface AppStateShape {
  view: AppView;
  /** The project a new session would use; null until one is opened. */
  project: ProjectRef | null;
  prefs: UiPrefs;
  /** True once preferences have been read from the main process. */
  prefsLoaded: boolean;
  paletteOpen: boolean;
  info: AppInfo | null;
  /** Transient, user-visible explanation for an action that is not wired yet. */
  hint: string | null;
  /** Open session tabs (plan step 3); the main process owns their hosts. */
  tabs: TabRecord[];
  activeTabId: string | null;
  /** Per-tab event counter/last event: proof the host pipe is live (step 5 renders it). */
  transcripts: Record<string, TranscriptState>;
  /** Latest `state.get` snapshot per tab (opaque to the renderer). */
  sessionStates: Record<string, unknown>;

  setView: (view: AppView) => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  setPrefs: (patch: Partial<UiPrefs>) => void;
  toggleSidebar: () => void;
  setInfo: (info: AppInfo) => void;
  openProject: (path: string) => void;
  closeProject: () => void;
  setHint: (hint: string | null) => void;
  loadPrefs: () => Promise<void>;
  /** Sessions (plan step 3). */
  loadTabs: () => Promise<void>;
  applyTabs: (envelope: SessionTabsEnvelope) => void;
  applySessionEvents: (envelope: SessionEventEnvelope) => void;
  applySessionState: (envelope: SessionStateEnvelope) => void;
  /** Loads history from `messages.get` once per tab (plan step 5). */
  hydrateTranscript: (tabId: string) => Promise<void>;
  /** Aborts the run of a tab (the transcript's error banner action). */
  abortTab: (tabId: string) => Promise<void>;

  /** Composer (plan step 6). */
  sendModes: Record<string, SendMode>;
  draftHistory: Record<string, string[]>;
  /** Where the user is browsing history for a tab (-1 = the live draft). */
  historyIndex: Record<string, number>;
  setSendMode: (tabId: string, mode: SendMode) => void;
  setDraft: (tabId: string, text: string) => void;
  sendPrompt: (
    tabId: string,
    text: string,
    options?: { mode?: SendMode; images?: PromptImage[] },
  ) => Promise<boolean>;
  /** `clearQueue` then `abort`, restoring the queued text into the draft. */
  stopRun: (tabId: string) => Promise<void>;
  clearQueue: (tabId: string) => Promise<void>;
  historyStep: (tabId: string, direction: 1 | -1) => string | null;
  createSessionTab: () => Promise<void>;
  activateTab: (tabId: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  closeActiveTab: () => Promise<void>;
  cycleTab: (direction: 1 | -1) => Promise<void>;
}

/** The last path segment of a project directory, used as its display name. */
export function projectNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function bridge(): Window["pi"] | undefined {
  return typeof window === "undefined" ? undefined : window.pi;
}

export const useAppStore = create<AppStateShape>()((set, get) => ({
  view: "welcome",
  project: null,
  prefs: { ...DEFAULT_PREFS },
  prefsLoaded: false,
  paletteOpen: false,
  info: null,
  hint: null,
  tabs: [],
  activeTabId: null,
  transcripts: {},
  sessionStates: {},
  sendModes: {},
  draftHistory: {},
  historyIndex: {},

  setView: (view) => set({ view, hint: null }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),

  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    void bridge()?.prefs.set(patch);
  },

  toggleSidebar: () => get().setPrefs({ sidebarCollapsed: !get().prefs.sidebarCollapsed }),

  setInfo: (info) => set({ info }),

  openProject: (path) =>
    set({
      project: { path, name: projectNameOf(path) },
      view: "session",
      hint: null,
    }),

  closeProject: () => set({ project: null, view: "welcome" }),

  setHint: (hint) => set({ hint }),

  loadPrefs: async () => {
    const api = bridge();
    if (!api) {
      set({ prefsLoaded: true });
      return;
    }
    try {
      const prefs = await api.prefs.get();
      set({ prefs, prefsLoaded: true });
    } catch {
      set({ prefsLoaded: true });
    }
  },

  loadTabs: async () => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      get().applyTabs(await api.sessions.list());
    } catch {
      // Reading the tab table must never break the shell.
    }
  },

  applyTabs: (envelope) => set({ tabs: envelope.tabs, activeTabId: envelope.activeTabId }),

  applySessionEvents: (envelope) => {
    const current = get().transcripts[envelope.tabId] ?? createTranscriptState();
    set({
      transcripts: {
        ...get().transcripts,
        [envelope.tabId]: reduceSessionEvents(current, envelope.events, envelope.seq),
      },
    });
  },

  applySessionState: (envelope) =>
    set({ sessionStates: { ...get().sessionStates, [envelope.tabId]: envelope.state } }),

  hydrateTranscript: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    const current = get().transcripts[tabId];
    if (current?.hydrated) return;
    try {
      const result = (await api.sessions.request({ tabId, method: "messages.get" })) as {
        messages?: unknown[];
      };
      const base = get().transcripts[tabId] ?? createTranscriptState();
      set({
        transcripts: {
          ...get().transcripts,
          [tabId]: hydrateMessages(base, result.messages ?? []),
        },
      });
    } catch {
      // A session that cannot report history still streams; hydration is best effort.
      const base = get().transcripts[tabId] ?? createTranscriptState();
      set({
        transcripts: { ...get().transcripts, [tabId]: { ...base, hydrated: true } },
      });
    }
  },

  abortTab: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({ tabId, method: "abort" });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  setSendMode: (tabId, mode) => set({ sendModes: { ...get().sendModes, [tabId]: mode } }),

  setDraft: (tabId, text) => {
    const drafts = { ...get().prefs.drafts, [tabId]: text };
    set({ prefs: { ...get().prefs, drafts } });
    if (draftPersistTimer) clearTimeout(draftPersistTimer);
    draftPersistTimer = setTimeout(() => {
      draftPersistTimer = null;
      void bridge()?.prefs.set({ drafts: useAppStore.getState().prefs.drafts });
    }, DRAFT_PERSIST_DELAY_MS);
  },

  sendPrompt: async (tabId, text, options = {}) => {
    const api = bridge();
    const trimmed = text.trim();
    if (!api?.sessions || trimmed.length === 0) return false;
    const running = get().tabs.find((tab) => tab.id === tabId)?.status === "running";
    // Mirrors the host's rule (step 4): while streaming, a delivery mode is
    // required, so the caller must have chosen steer or follow-up first.
    if (running && !options.mode) return false;
    const params: Record<string, unknown> = { text: trimmed };
    if (options.images && options.images.length > 0) params.images = options.images;
    if (running && options.mode) params.streamingBehavior = options.mode;
    try {
      await api.sessions.request({ tabId, method: "prompt", params });
      get().setDraft(tabId, "");
      const history = get().draftHistory[tabId] ?? [];
      set({
        draftHistory: { ...get().draftHistory, [tabId]: [trimmed, ...history].slice(0, 50) },
        historyIndex: { ...get().historyIndex, [tabId]: -1 },
      });
      return true;
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  stopRun: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      // The RPC recipe: take the queue back first, abort, then hand the queued
      // text to the editor so a cancelled run never loses what the user typed.
      const result = (await api.sessions.request({ tabId, method: "clearQueue" })) as {
        cleared?: { steering?: string[]; followUp?: string[] };
      };
      await api.sessions.request({ tabId, method: "abort" });
      const restored = [
        ...(result?.cleared?.steering ?? []),
        ...(result?.cleared?.followUp ?? []),
      ].join("\n\n");
      if (restored.length > 0) get().setDraft(tabId, restored);
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  clearQueue: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({ tabId, method: "clearQueue" });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  historyStep: (tabId, direction) => {
    const history = get().draftHistory[tabId] ?? [];
    if (history.length === 0) return null;
    const current = get().historyIndex[tabId] ?? -1;
    // -1 means "the live draft"; older entries walk forward through the list.
    const next =
      direction === -1 ? Math.min(current + 1, history.length - 1) : Math.max(current - 1, -1);
    set({ historyIndex: { ...get().historyIndex, [tabId]: next } });
    return next === -1 ? null : (history[next] ?? null);
  },

  createSessionTab: async () => {
    const { project, setHint } = get();
    const api = bridge();
    if (!project) {
      setHint("Choose a project first — open a folder with “Open project…”, then start a session.");
      return;
    }
    if (!api?.sessions) {
      setHint("The preload bridge is unavailable.");
      return;
    }
    try {
      get().applyTabs(await api.sessions.create({ cwd: project.path }));
      set({ view: "session", hint: null });
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error));
    }
  },

  activateTab: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    set({ activeTabId: tabId, view: "session" });
    try {
      get().applyTabs(await api.sessions.activate(tabId));
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  closeTab: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      get().applyTabs(await api.sessions.close(tabId));
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  closeActiveTab: async () => {
    const { activeTabId } = get();
    if (!activeTabId) return;
    await get().closeTab(activeTabId);
  },

  cycleTab: async (direction) => {
    const { tabs, activeTabId } = get();
    if (tabs.length < 2) return;
    const index = tabs.findIndex((tab) => tab.id === activeTabId);
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    if (next) await get().activateTab(next.id);
  },
}));

/** Imperative access for non-React callers (menu commands, keyboard shortcuts). */
export const appStore = useAppStore;
