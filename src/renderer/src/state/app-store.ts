import { create } from "zustand";
import type { AppInfo } from "../../../shared/ipc";
import {
  DEFAULT_PREFS,
  toggleFavoriteModel,
  type UiPrefs,
  type ViewMode,
} from "../../../shared/prefs";
import {
  PROVIDER_LOGIN_EVENT,
  isProviderLoginPrompt,
  type ProviderAuthPrompt,
  type ProviderLoginEvent,
  type ProviderSummary,
} from "../../../shared/providers";
import {
  CONTROL_TAB_ID,
  type SessionEventEnvelope,
  type SessionEventEntry,
  type SessionStateEnvelope,
  type SessionTabsEnvelope,
  type TabRecord,
} from "../../../shared/session-ipc";
import {
  createTranscriptState,
  hydrateMessages,
  reduceSessionEvents,
  type TranscriptState,
} from "../session/session-events";
import { appCommandNames, resolveCommandInput } from "../completion/dispatch";
import type { HostCommandEntry } from "../completion/command-source";
import type { FileListSnapshot } from "../completion/file-source";
import type { CompletionSource } from "../completion/types";
import { thinkingLevelsOf, toCatalog, type ModelCatalogEntry } from "../session/model-catalog";

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
    options?: { mode?: SendMode; images?: PromptImage[]; preferredSource?: CompletionSource },
  ) => Promise<boolean>;
  /** Sends without command routing (used by the dispatch table itself). */
  sendPromptNow: (
    tabId: string,
    text: string,
    options?: { mode?: SendMode; images?: PromptImage[] },
  ) => Promise<boolean>;
  /** `clearQueue` then `abort`, restoring the queued text into the draft. */
  stopRun: (tabId: string) => Promise<void>;
  clearQueue: (tabId: string) => Promise<void>;
  historyStep: (tabId: string, direction: 1 | -1) => string | null;

  /** Completion engine (plan step 7). */
  completionCommands: Record<string, HostCommandEntry[]>;
  completionFiles: Record<string, FileCacheEntry>;
  loadCommands: (tabId: string, options?: { refresh?: boolean }) => Promise<HostCommandEntry[]>;
  loadFiles: (tabId: string, options?: { refresh?: boolean }) => Promise<FileListSnapshot | null>;
  /**
   * Runs a submitted `/command`. `handled: false` means the text is not a
   * command and the caller should treat it as a prompt; `sent: false` with
   * `handled: true` means the app consumed it (view switch, hint).
   */
  runCommandInput: (
    tabId: string,
    text: string,
    preferredSource?: CompletionSource,
  ) => Promise<CommandOutcome>;

  /** Model, thinking and usage UX (plan step 8). */
  modelCatalog: Record<string, ModelCatalogEntry[]>;
  providerAuth: Record<string, Record<string, unknown>>;
  thinkingLevels: Record<string, string[]>;
  picker: PickerKind | null;
  loadModels: (tabId: string) => Promise<void>;
  setModel: (
    tabId: string,
    entry: ModelCatalogEntry,
    options?: { persist?: boolean },
  ) => Promise<void>;
  setThinking: (tabId: string, level: string, options?: { persist?: boolean }) => Promise<void>;
  cycleModel: (tabId: string, direction: 1 | -1) => Promise<void>;
  cycleThinking: (tabId: string) => Promise<void>;
  renameSession: (tabId: string, name: string) => Promise<void>;
  toggleFavorite: (key: string) => void;
  setViewMode: (mode: ViewMode) => void;
  openPicker: (picker: PickerKind) => void;
  closePicker: () => void;

  /** Connections — providers, credentials and sign-in (plan step 9). */
  providers: ProviderSummary[];
  providersLoaded: boolean;
  providersError: string | null;
  providerLogin: ProviderLoginState | null;
  loadProviders: () => Promise<void>;
  /** Writes a key through Pi; throws so the write-only form can show the error. */
  setProviderKey: (providerId: string, apiKey: string) => Promise<void>;
  logoutProvider: (providerId: string) => Promise<void>;
  startProviderLogin: (providerId: string) => Promise<void>;
  cancelProviderLogin: () => Promise<void>;
  /** Aborts a running sign-in, then hides the dialog. */
  dismissProviderLogin: () => void;
  answerProviderLogin: (value: string | undefined) => Promise<void>;
  /** Routes a control-host event (provider login) rather than a transcript. */
  applyControlEvent: (entry: SessionEventEntry) => void;

  createSessionTab: () => Promise<void>;
  activateTab: (tabId: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  closeActiveTab: () => Promise<void>;
  cycleTab: (direction: 1 | -1) => Promise<void>;
}

/** How long a `files.list` result is reused before it is fetched again. */
export const FILE_CACHE_TTL_MS = 30_000;

export interface FileCacheEntry {
  files: string[];
  root: string;
  truncated: boolean;
  fetchedAt: number;
}

/** What running a `/command` did (plan step 7). */
export interface CommandOutcome {
  /** False when the text was not a command at all. */
  handled: boolean;
  /** True when something was actually sent to the agent (or a host method ran). */
  sent: boolean;
}

/** Which model/thinking dialog is open (plan step 8). */
export type PickerKind = "model" | "thinking";

/**
 * The visible state of an in-flight provider sign-in (plan step 9).
 *
 * `url`/`deviceCode` mirror what Pi reported; the URL has already been opened
 * in the system browser, and `prompt` is the `oi.request` the flow is blocked on
 * until `answerProviderLogin` responds.
 */
export interface ProviderLoginState {
  loginId: string;
  providerId: string;
  status: "running" | "done" | "error" | "cancelled";
  message: string | null;
  url: string | null;
  deviceCode: { userCode: string; verificationUri: string } | null;
  prompt: { id: string; prompt: ProviderAuthPrompt } | null;
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
  completionCommands: {},
  completionFiles: {},
  modelCatalog: {},
  providerAuth: {},
  thinkingLevels: {},
  picker: null,
  providers: [],
  providersLoaded: false,
  providersError: null,
  providerLogin: null,

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
    // The control host is addressed like a tab but has no transcript: its events
    // are provider-login progress and prompts (plan step 9).
    if (envelope.tabId === CONTROL_TAB_ID) {
      for (const entry of envelope.events) get().applyControlEvent(entry);
      return;
    }
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

  openPicker: (picker) => set({ picker }),
  closePicker: () => set({ picker: null }),

  loadModels: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const response = (await api.sessions.request({ tabId, method: "model.available" })) as
        | {
            models?: unknown[];
            auth?: Record<string, unknown>;
            thinkingLevels?: unknown[];
          }
        | undefined;
      set({
        modelCatalog: {
          ...get().modelCatalog,
          [tabId]: toCatalog(Array.isArray(response?.models) ? response.models : []),
        },
        providerAuth: { ...get().providerAuth, [tabId]: response?.auth ?? {} },
        thinkingLevels: {
          ...get().thinkingLevels,
          [tabId]: thinkingLevelsOf({ thinkingLevels: response?.thinkingLevels }),
        },
      });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  setModel: async (tabId, entry, options = {}) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const response = await api.sessions.request({
        tabId,
        method: "model.set",
        params: { model: entry.raw, persist: options.persist === true },
      });
      // A different model can mean a different set of thinking levels, so the
      // clamp is re-read from the state the host returns instead of cached.
      set({
        picker: null,
        thinkingLevels: { ...get().thinkingLevels, [tabId]: thinkingLevelsOf(response) },
      });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  setThinking: async (tabId, level, options = {}) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({
        tabId,
        method: "thinking.set",
        params: { level, persist: options.persist === true },
      });
      set({ picker: null });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  cycleModel: async (tabId, direction) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({
        tabId,
        method: "model.cycle",
        params: { direction: direction === -1 ? "backward" : "forward", persist: false },
      });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  cycleThinking: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({ tabId, method: "thinking.cycle", params: { persist: false } });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  renameSession: async (tabId, name) => {
    const api = bridge();
    const trimmed = name.trim();
    if (!api?.sessions || trimmed.length === 0) return;
    try {
      await api.sessions.request({ tabId, method: "session.rename", params: { name: trimmed } });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  toggleFavorite: (key) => {
    const favorites = toggleFavoriteModel(get().prefs.favoriteModels, key);
    set({ prefs: { ...get().prefs, favoriteModels: favorites } });
    void bridge()?.prefs.set({ favoriteModels: favorites });
  },

  setViewMode: (mode) => {
    set({ prefs: { ...get().prefs, viewMode: mode } });
    void bridge()?.prefs.set({ viewMode: mode });
  },

  sendPromptNow: async (tabId, text, options = {}) => {
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

  /**
   * The send path (plan step 7): a leading `/` is resolved before anything is
   * sent, so an unknown command becomes a hint instead of a literal prompt.
   */
  sendPrompt: async (tabId, text, options = {}) => {
    if (text.trim().startsWith("/")) {
      const outcome = await get().runCommandInput(tabId, text, options.preferredSource);
      // `handled` covers an executed command, a view switch and an unknown name:
      // in every one of those cases the text was consumed, not sent as prose.
      if (outcome.handled) return true;
    }
    return get().sendPromptNow(tabId, text, options);
  },

  loadCommands: async (tabId, options = {}) => {
    const cached = get().completionCommands[tabId];
    if (cached && !options.refresh) return cached;
    const api = bridge();
    if (!api?.sessions) return cached ?? [];
    try {
      const response = (await api.sessions.request({ tabId, method: "commands.list" })) as
        { commands?: HostCommandEntry[] } | undefined;
      const commands = Array.isArray(response?.commands) ? response.commands : [];
      set({ completionCommands: { ...get().completionCommands, [tabId]: commands } });
      return commands;
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
      return cached ?? [];
    }
  },

  loadFiles: async (tabId, options = {}) => {
    const cached = get().completionFiles[tabId];
    const fresh = cached !== undefined && Date.now() - cached.fetchedAt < FILE_CACHE_TTL_MS;
    if (cached && fresh && !options.refresh) return cached;
    const api = bridge();
    if (!api?.sessions) return cached ?? null;
    try {
      const response = (await api.sessions.request({ tabId, method: "files.list" })) as
        { files?: unknown; root?: unknown; truncated?: unknown } | undefined;
      const entry: FileCacheEntry = {
        files: Array.isArray(response?.files) ? response.files.map((file) => String(file)) : [],
        root: typeof response?.root === "string" ? response.root : "",
        truncated: response?.truncated === true,
        fetchedAt: Date.now(),
      };
      set({ completionFiles: { ...get().completionFiles, [tabId]: entry } });
      return entry;
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
      return cached ?? null;
    }
  },

  runCommandInput: async (tabId, text, preferredSource) => {
    const hostCommands = await get().loadCommands(tabId);
    const resolution = resolveCommandInput(text, {
      hostCommands,
      ...(preferredSource ? { preferredSource } : {}),
    });

    if (resolution.kind === "not-a-command") return { handled: false, sent: false };

    if (resolution.kind === "unknown") {
      set({ hint: `Unknown command /${resolution.name} — press / to list commands.` });
      return { handled: true, sent: false };
    }

    // Extension commands, prompt templates and /skill:* are sent as a prompt so
    // the SDK expands them; nothing is interpreted here.
    if (resolution.kind === "host") {
      const sent = await get().sendPromptNow(tabId, text);
      return { handled: true, sent };
    }

    const { name, argument, command } = resolution;
    const action = command.action;
    get().setDraft(tabId, "");

    if (action.kind === "pending") {
      set({ hint: `/${name}: ${action.message}` });
      return { handled: true, sent: false };
    }
    if (action.kind === "help") {
      set({ hint: `Commands: ${appCommandNames().join("  ·  ")}` });
      return { handled: true, sent: false };
    }
    if (action.kind === "view") {
      set({ view: action.view, hint: null });
      return { handled: true, sent: false };
    }
    if (action.kind === "picker") {
      // The model picker needs the catalog, so it is fetched as the dialog opens.
      set({ picker: action.picker, hint: null });
      if (action.picker === "model") void get().loadModels(tabId);
      return { handled: true, sent: false };
    }
    if (action.requiresArgument && argument.length === 0) {
      set({ hint: `/${name} needs ${command.argumentHint ?? "an argument"}.` });
      return { handled: true, sent: false };
    }

    const api = bridge();
    if (!api?.sessions) {
      set({ hint: "The preload bridge is unavailable." });
      return { handled: true, sent: false };
    }
    try {
      await api.sessions.request({
        tabId,
        method: action.method,
        params: action.params ? action.params(argument) : {},
      });
      return { handled: true, sent: true };
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
      return { handled: true, sent: false };
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

  // ---- Connections: providers, credentials and sign-in (plan step 9) ----

  loadProviders: async () => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const result = (await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "providers.list",
      })) as { providers?: ProviderSummary[] };
      set({ providers: result.providers ?? [], providersLoaded: true, providersError: null });
    } catch (error) {
      set({
        providersLoaded: true,
        providersError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  setProviderKey: async (providerId, apiKey) => {
    const api = bridge();
    if (!api?.sessions) throw new Error("The preload bridge is unavailable.");
    // The key travels one way: it is sent and never read back.
    await api.sessions.request({
      tabId: CONTROL_TAB_ID,
      method: "providers.setKey",
      params: { providerId, apiKey },
    });
    await get().loadProviders();
  },

  logoutProvider: async (providerId) => {
    const api = bridge();
    if (!api?.sessions) return;
    await api.sessions.request({
      tabId: CONTROL_TAB_ID,
      method: "providers.logout",
      params: { providerId },
    });
    await get().loadProviders();
  },

  startProviderLogin: async (providerId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const result = (await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "providers.login",
        params: { providerId },
      })) as { loginId?: string };
      if (result?.loginId) {
        set({
          providerLogin: {
            loginId: result.loginId,
            providerId,
            status: "running",
            message: null,
            url: null,
            deviceCode: null,
            prompt: null,
          },
        });
      }
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  cancelProviderLogin: async () => {
    const login = get().providerLogin;
    const api = bridge();
    if (!login || !api?.sessions) return;
    if (login.status === "running") {
      // Abort first so the flow stops even if the dialog is gone next tick.
      try {
        await api.sessions.request({
          tabId: CONTROL_TAB_ID,
          method: "providers.cancel",
          params: { loginId: login.loginId },
        });
      } catch {
        // The flow may already have finished; the terminal event is authoritative.
      }
    }
    set({ providerLogin: null });
  },

  dismissProviderLogin: () => {
    void get().cancelProviderLogin();
  },

  answerProviderLogin: async (value) => {
    const login = get().providerLogin;
    const api = bridge();
    if (!login?.prompt || !api?.sessions) return;
    try {
      await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "oi.respond",
        params: { id: login.prompt.id, value },
      });
      set({ providerLogin: { ...login, prompt: null } });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  applyControlEvent: (entry) => {
    if (entry.event === PROVIDER_LOGIN_EVENT) {
      const event = entry.payload as ProviderLoginEvent | undefined;
      if (!event) return;

      if (event.phase === "started") {
        set({
          providerLogin: {
            loginId: event.loginId,
            providerId: event.providerId,
            status: "running",
            message: null,
            url: null,
            deviceCode: null,
            prompt: null,
          },
        });
        return;
      }

      const current = get().providerLogin;
      // A late event from a previous attempt must not reopen a closed dialog.
      if (current && current.loginId !== event.loginId) return;
      const base: ProviderLoginState = current ?? {
        loginId: event.loginId,
        providerId: event.providerId,
        status: "running",
        message: null,
        url: null,
        deviceCode: null,
        prompt: null,
      };

      if (event.phase === "progress") {
        const next: ProviderLoginState = { ...base };
        if (event.event.type === "progress" || event.event.type === "info") {
          next.message = event.event.message;
        } else if (event.event.type === "auth_url") {
          next.url = event.event.url;
          next.message = event.event.instructions ?? "Finish signing in in your browser.";
          // System browser by default (plan step 9); an in-app tab is step 21.
          void bridge()?.openExternal(event.event.url);
        } else if (event.event.type === "device_code") {
          next.deviceCode = {
            userCode: event.event.userCode,
            verificationUri: event.event.verificationUri,
          };
          next.message = `Enter code ${event.event.userCode}`;
          void bridge()?.openExternal(event.event.verificationUri);
        }
        set({ providerLogin: next });
        return;
      }

      const status =
        event.phase === "done" ? "done" : event.phase === "error" ? "error" : "cancelled";
      const message =
        event.phase === "error"
          ? event.message
          : event.phase === "done"
            ? "Signed in."
            : "Cancelled.";
      set({ providerLogin: { ...base, status, message, prompt: null } });
      if (event.phase === "done") void get().loadProviders();
      return;
    }

    if (entry.event === "oi.request") {
      const payload = entry.payload as { id?: unknown; params?: unknown } | undefined;
      if (!payload || typeof payload.id !== "string" || !isProviderLoginPrompt(payload.params)) {
        return;
      }
      const login = get().providerLogin;
      if (!login || login.loginId !== payload.params.loginId) return;
      set({
        providerLogin: { ...login, prompt: { id: payload.id, prompt: payload.params.prompt } },
      });
    }
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
