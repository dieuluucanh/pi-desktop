/**
 * Terminal view state (2026-11-05 native-terminal plan, step 8).
 *
 * A thin zustand store over the bridge and the xterm pool. It owns the tab ↔
 * terminal mapping, the replay boundary (`lastSeq`) and the lifecycle words the
 * view renders. The pool owns the xterm instances; this store never touches the
 * DOM.
 *
 * Replay rule: `create`/`reattach` write the host's ring buffer and set
 * `lastSeq` to its sequence. Data frames at or below that sequence (emitted
 * before the replay was taken) are dropped, which is what makes a reload
 * duplicate-free without buffering early frames.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import type { TerminalBridge } from "../../../shared/terminal-ipc";
import type { TerminalAttachResult } from "../../../shared/terminal-protocol";
import { base64ToBytes } from "../../../shared/terminal-protocol";
import type { TerminalPool, TerminalPoolOptions } from "../terminal/terminal-pool";

export type TerminalStatus = "idle" | "starting" | "attached" | "needs-trust" | "exited" | "failed";

export interface TerminalTabState {
  terminalId: string | null;
  status: TerminalStatus;
  title: string;
  cwd: string;
  pid: number | null;
  exitCode: number | null;
  error: string | null;
  /** Highest data sequence already written (the replay boundary at first). */
  lastSeq: number;
  cols: number;
  rows: number;
}

export interface TerminalStoreDeps {
  bridge: TerminalBridge;
  pool: TerminalPool;
  /** xterm options for a newly created terminal (theme/font from prefs). */
  options: (cols: number, rows: number) => TerminalPoolOptions;
  /** Opens the existing project-trust prompt; false means "do not spawn". */
  requestTrust: (cwd: string) => Promise<boolean>;
  log?: (line: string) => void;
}

export interface TerminalStoreState {
  tabs: Record<string, TerminalTabState>;
  create(
    tabId: string,
    cwd: string,
    cols: number,
    rows: number,
    trust?: "session" | "trust" | "never",
    profileId?: string | null,
  ): Promise<boolean>;
  /** Reattaches a live terminal after a remount/reload; false when it is gone. */
  reattach(tabId: string, cwd: string): Promise<boolean>;
  write(tabId: string, data: string): void;
  resize(tabId: string, cols: number, rows: number): void;
  close(tabId: string): Promise<void>;
  handleData(terminalId: string, bytes: Uint8Array, seq: number): void;
  handleExit(terminalId: string, exitCode: number, signal?: number): void;
  handleError(terminalId: string | null, message: string): void;
  removeTab(tabId: string): void;
  forTab(tabId: string): TerminalTabState | undefined;
}

export type TerminalStore = StoreApi<TerminalStoreState>;

function blank(cwd: string, cols: number, rows: number): TerminalTabState {
  return {
    terminalId: null,
    status: "idle",
    title: "",
    cwd,
    pid: null,
    exitCode: null,
    error: null,
    lastSeq: 0,
    cols,
    rows,
  };
}

export function createTerminalStore(deps: TerminalStoreDeps): TerminalStore {
  return createStore<TerminalStoreState>((set, get) => {
    const findByTerminal = (terminalId: string): [string, TerminalTabState] | null => {
      for (const [tabId, state] of Object.entries(get().tabs)) {
        if (state.terminalId === terminalId) return [tabId, state];
      }
      return null;
    };

    const patch = (tabId: string, next: Partial<TerminalTabState>): void => {
      const current = get().tabs[tabId];
      if (!current) return;
      set({ tabs: { ...get().tabs, [tabId]: { ...current, ...next } } });
    };

    const writeReplay = (terminalId: string, replay: TerminalAttachResult): void => {
      if (replay.bytes <= 0) return;
      const bytes = base64ToBytes(replay.data);
      deps.pool.write(terminalId, bytes, () => {
        deps.bridge.ack(terminalId, bytes.length);
      });
    };

    const runCreate = async (
      tabId: string,
      cwd: string,
      cols: number,
      rows: number,
      trust?: "session" | "trust" | "never",
      profileId?: string | null,
    ): Promise<boolean> => {
      const outcome = await deps.bridge.create({
        tabId,
        cols,
        rows,
        ...(trust ? { trust } : {}),
        ...(profileId ? { profileId } : {}),
      });
      if (outcome.kind === "needs-trust") {
        const granted = await deps.requestTrust(outcome.cwd);
        if (!granted) {
          patch(tabId, { status: "needs-trust", error: null });
          return false;
        }
        return runCreate(tabId, cwd, cols, rows, "session", profileId);
      }
      if (outcome.kind === "unavailable") {
        patch(tabId, { status: "failed", error: outcome.message });
        return false;
      }
      if (outcome.kind === "error") {
        patch(tabId, { status: "failed", error: outcome.message });
        return false;
      }

      deps.pool.create(outcome.terminal.id, deps.options(cols, rows));
      writeReplay(outcome.terminal.id, outcome.replay);
      patch(tabId, {
        terminalId: outcome.terminal.id,
        status: "attached",
        title: outcome.terminal.title,
        cwd: outcome.terminal.cwd,
        pid: outcome.terminal.pid,
        cols: outcome.terminal.cols,
        rows: outcome.terminal.rows,
        lastSeq: outcome.replay.seq,
        exitCode: null,
        error: null,
      });
      return true;
    };

    return {
      tabs: {},

      async create(tabId, cwd, cols, rows, trust, profileId) {
        const current = get().tabs[tabId];
        if (current?.terminalId && current.status === "attached") return true;
        if (current?.status === "starting") return false;
        set({
          tabs: {
            ...get().tabs,
            [tabId]: {
              ...(current ?? blank(cwd, cols, rows)),
              status: "starting",
              cwd,
              cols,
              rows,
            },
          },
        });
        try {
          return await runCreate(tabId, cwd, cols, rows, trust, profileId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.log?.(`terminal create failed: ${message}`);
          patch(tabId, { status: "failed", error: message });
          return false;
        }
      },

      async reattach(tabId, cwd) {
        const current = get().tabs[tabId];
        if (!current?.terminalId)
          return get().create(tabId, cwd, current?.cols ?? 80, current?.rows ?? 24);
        const replay = await deps.bridge.attach(current.terminalId);
        if (!replay) {
          // The host forgot it (a crash or a restart): no shell to reattach to.
          deps.pool.dispose(current.terminalId);
          patch(tabId, { terminalId: null, status: "exited", lastSeq: 0 });
          return false;
        }
        if (!deps.pool.has(current.terminalId)) {
          deps.pool.create(current.terminalId, deps.options(current.cols, current.rows));
        }
        writeReplay(current.terminalId, replay);
        patch(tabId, { status: "attached", lastSeq: replay.seq });
        return true;
      },

      write(tabId, data) {
        const terminalId = get().tabs[tabId]?.terminalId;
        if (!terminalId) return;
        void deps.bridge.write(terminalId, data).catch((error: unknown) => {
          deps.log?.(`terminal write failed: ${String(error)}`);
        });
      },

      resize(tabId, cols, rows) {
        const state = get().tabs[tabId];
        if (!state?.terminalId || (state.cols === cols && state.rows === rows)) return;
        if (cols <= 0 || rows <= 0) return;
        patch(tabId, { cols, rows });
        void deps.bridge.resize(state.terminalId, cols, rows).catch((error: unknown) => {
          deps.log?.(`terminal resize failed: ${String(error)}`);
        });
      },

      async close(tabId) {
        const state = get().tabs[tabId];
        if (!state) return;
        if (state.terminalId) {
          deps.pool.dispose(state.terminalId);
          await deps.bridge.close(state.terminalId).catch((error: unknown) => {
            deps.log?.(`terminal close failed: ${String(error)}`);
            return false;
          });
        }
        const tabs = { ...get().tabs };
        delete tabs[tabId];
        set({ tabs });
      },

      handleData(terminalId, bytes, seq) {
        const found = findByTerminal(terminalId);
        if (!found) return;
        const [tabId, state] = found;
        if (seq <= state.lastSeq) return;
        if (!deps.pool.write(terminalId, bytes, () => deps.bridge.ack(terminalId, bytes.length))) {
          return;
        }
        patch(tabId, { lastSeq: seq });
      },

      handleExit(terminalId, exitCode, signal) {
        const found = findByTerminal(terminalId);
        if (!found) return;
        const [tabId] = found;
        patch(tabId, {
          status: "exited",
          exitCode,
          error: signal ? `the shell exited (signal ${signal})` : null,
        });
      },

      handleError(terminalId, message) {
        if (!terminalId) {
          deps.log?.(`terminal host error: ${message}`);
          return;
        }
        const found = findByTerminal(terminalId);
        if (!found) return;
        patch(found[0], { status: "failed", error: message });
      },

      removeTab(tabId) {
        const state = get().tabs[tabId];
        if (!state) return;
        if (state.terminalId) {
          deps.pool.dispose(state.terminalId);
          void deps.bridge.close(state.terminalId).catch(() => undefined);
        }
        const tabs = { ...get().tabs };
        delete tabs[tabId];
        set({ tabs });
      },

      forTab(tabId) {
        return get().tabs[tabId];
      },
    };
  });
}
