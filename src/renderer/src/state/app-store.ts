import { create } from "zustand";
import type { AppInfo } from "../../../shared/ipc";
import { DEFAULT_PREFS, type UiPrefs } from "../../../shared/prefs";
import type {
  SessionEventEnvelope,
  SessionStateEnvelope,
  SessionTabsEnvelope,
  TabRecord,
} from "../../../shared/session-ipc";

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
  sessionEvents: Record<string, { count: number; last: string | null }>;
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
  sessionEvents: {},
  sessionStates: {},

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
    const current = get().sessionEvents[envelope.tabId] ?? { count: 0, last: null };
    const last = envelope.events.at(-1)?.event ?? current.last;
    set({
      sessionEvents: {
        ...get().sessionEvents,
        [envelope.tabId]: { count: current.count + envelope.events.length, last },
      },
    });
  },

  applySessionState: (envelope) =>
    set({ sessionStates: { ...get().sessionStates, [envelope.tabId]: envelope.state } }),

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
