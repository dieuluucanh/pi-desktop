import { describe, expect, it } from "vitest";
import {
  createTerminalStore,
  type TerminalStoreDeps,
} from "../../src/renderer/src/state/terminal-store";
import {
  TerminalPool,
  type PoolTerminal,
  type TerminalPoolOptions,
} from "../../src/renderer/src/terminal/terminal-pool";
import type { TerminalBridge } from "../../src/shared/terminal-ipc";
import type { TerminalCreateOutcome } from "../../src/shared/terminal-ipc";
import type { TerminalAttachResult, TerminalInfo } from "../../src/shared/terminal-protocol";
import { bytesToBase64 } from "../../src/shared/terminal-protocol";
import { terminalThemeFromCssVariables } from "../../src/shared/terminal-theme";

function poolOptions(): TerminalPoolOptions {
  return {
    cols: 80,
    rows: 24,
    fontSize: 13,
    fontFamily: null,
    scrollback: 10_000,
    cursorStyle: "block",
    cursorBlink: true,
    macOptionIsMeta: false,
    theme: terminalThemeFromCssVariables(() => ""),
  };
}

class FakeTerm implements PoolTerminal {
  readonly element = document.createElement("div");
  readonly writes: Uint8Array[] = [];
  disposed = 0;
  write(bytes: Uint8Array, callback?: () => void): void {
    this.writes.push(bytes);
    callback?.();
  }
  focus(): void {}
  dispose(): void {
    this.disposed += 1;
  }
  fit(): { cols: number; rows: number } {
    return { cols: 100, rows: 40 };
  }
  getSelection(): string {
    return "";
  }
  clearSelection(): void {}
  selectAll(): void {}
  clear(): void {}
  findNext(): boolean {
    return true;
  }
  findPrevious(): boolean {
    return false;
  }
  setTheme(): void {}
  setOptions(): void {}
  onData(): () => void {
    return () => undefined;
  }
  attachKeyHandler(): void {}
  paste(): void {}
  onTitleChange(): () => void {
    return () => undefined;
  }
  onSelectionChange(): () => void {
    return () => undefined;
  }

  onBell(): () => void {
    return () => undefined;
  }
}

interface BridgeCalls {
  create: Array<{
    tabId: string;
    cols: number;
    rows: number;
    trust?: string;
    profileId?: string;
  }>;
  attach: string[];
  write: Array<[string, string]>;
  resize: Array<[string, number, number]>;
  close: string[];
  ack: Array<[string, number]>;
}

function createBridge(overrides: Partial<TerminalBridge> = {}): {
  bridge: TerminalBridge;
  calls: BridgeCalls;
} {
  const calls: BridgeCalls = {
    create: [],
    attach: [],
    write: [],
    resize: [],
    close: [],
    ack: [],
  };
  const info: TerminalInfo = {
    id: "t-1",
    pid: 100,
    title: "bash",
    cwd: "/work/app",
    cols: 80,
    rows: 24,
  };
  const bridge: TerminalBridge = {
    async create(input) {
      calls.create.push({
        tabId: input.tabId,
        cols: input.cols,
        rows: input.rows,
        ...(input.trust ? { trust: input.trust } : {}),
        ...(input.profileId ? { profileId: input.profileId } : {}),
      });
      return {
        kind: "ok",
        terminal: { ...info, cols: input.cols, rows: input.rows },
        replay: { data: "", bytes: 0, seq: 0 },
      } satisfies TerminalCreateOutcome;
    },
    async attach(terminalId) {
      calls.attach.push(terminalId);
      return { data: "", bytes: 0, seq: 0 } satisfies TerminalAttachResult;
    },
    async write(terminalId, data) {
      calls.write.push([terminalId, data]);
    },
    async resize(terminalId, cols, rows) {
      calls.resize.push([terminalId, cols, rows]);
    },
    async close(terminalId) {
      calls.close.push(terminalId);
      return true;
    },
    ack(terminalId, bytes) {
      calls.ack.push([terminalId, bytes]);
    },
    async list() {
      return [];
    },
    async profiles() {
      return { profiles: [], defaultProfileId: null, problems: [] };
    },
    setFocus() {},
    onEvent() {
      return () => undefined;
    },
    ...overrides,
  };
  return { bridge, calls };
}

function createStore(
  overrides: Partial<TerminalStoreDeps> = {},
  bridgeOverrides: Partial<TerminalBridge> = {},
) {
  const { bridge, calls } = createBridge(bridgeOverrides);
  const terms: FakeTerm[] = [];
  const pool = new TerminalPool({
    create() {
      const term = new FakeTerm();
      terms.push(term);
      return term;
    },
  });
  const stores: string[] = [];
  const store = createTerminalStore({
    bridge,
    pool,
    options: poolOptions,
    requestTrust: async () => true,
    log: (line) => stores.push(line),
    ...overrides,
  });
  return { store, calls, pool, terms, logs: stores };
}

describe("TerminalStore.create", () => {
  it("attaches the terminal, creates the xterm and records the replay boundary", async () => {
    const replayBytes = new TextEncoder().encode("hello");
    const attempts: Array<{ tabId: string; cols: number; rows: number }> = [];
    const { store, calls, pool, terms } = createStore(
      {},
      {
        async create(input) {
          attempts.push({ tabId: input.tabId, cols: input.cols, rows: input.rows });
          return {
            kind: "ok",
            terminal: { id: "t-1", pid: 100, title: "bash", cwd: "/work/app", cols: 80, rows: 24 },
            replay: { data: bytesToBase64(replayBytes), bytes: replayBytes.length, seq: 4 },
          };
        },
      },
    );

    await expect(store.getState().create("tab-1", "/work/app", 80, 24)).resolves.toBe(true);
    expect(attempts).toEqual([{ tabId: "tab-1", cols: 80, rows: 24 }]);
    expect(pool.has("t-1")).toBe(true);
    const state = store.getState().forTab("tab-1");
    expect(state).toMatchObject({
      terminalId: "t-1",
      status: "attached",
      pid: 100,
      lastSeq: 4,
    });
    expect(Array.from(terms[0]!.writes[0]!)).toEqual(Array.from(replayBytes));
    expect(calls.ack).toEqual([["t-1", replayBytes.length]]);
  });

  it("is idempotent while attached", async () => {
    const { store, calls } = createStore();
    await store.getState().create("tab-1", "/work/app", 80, 24);
    await store.getState().create("tab-1", "/work/app", 80, 24);
    expect(calls.create).toHaveLength(1);
  });

  it("forwards the tab's shell profile", async () => {
    const { store, calls } = createStore();
    await store.getState().create("tab-1", "/work/app", 80, 24, undefined, "git-bash");
    expect(calls.create[0]).toMatchObject({ tabId: "tab-1", profileId: "git-bash" });
  });

  it("asks for trust, retries with a session grant, and fails on refusal", async () => {
    const attempts: Array<string | undefined> = [];
    const { store } = createStore(
      { requestTrust: async () => true },
      {
        async create(input) {
          attempts.push(input.trust);
          if (!input.trust) return { kind: "needs-trust", cwd: "/work/app" };
          return {
            kind: "ok",
            terminal: { id: "t-1", pid: 1, title: "bash", cwd: "/work/app", cols: 80, rows: 24 },
            replay: { data: "", bytes: 0, seq: 0 },
          };
        },
      },
    );
    await expect(store.getState().create("tab-1", "/work/app", 80, 24)).resolves.toBe(true);
    expect(attempts).toEqual([undefined, "session"]);

    const denied = createStore(
      { requestTrust: async () => false },
      {
        async create() {
          return { kind: "needs-trust", cwd: "/work/app" };
        },
      },
    );
    await expect(denied.store.getState().create("tab-2", "/work/app", 80, 24)).resolves.toBe(false);
    expect(denied.store.getState().forTab("tab-2")).toMatchObject({
      status: "needs-trust",
      error: null,
    });
  });

  it("records an unavailable/error outcome as failed", async () => {
    const unavailable = createStore(
      {},
      {
        async create() {
          return { kind: "unavailable", message: "no shell", profiles: [] };
        },
      },
    );
    await unavailable.store.getState().create("tab-1", "/work/app", 80, 24);
    expect(unavailable.store.getState().forTab("tab-1")).toMatchObject({
      status: "failed",
      error: "no shell",
    });

    const broken = createStore(
      {},
      {
        async create() {
          return { kind: "error", code: "spawn_failed", message: "boom" };
        },
      },
    );
    await broken.store.getState().create("tab-1", "/work/app", 80, 24);
    expect(broken.store.getState().forTab("tab-1")).toMatchObject({
      status: "failed",
      error: "boom",
    });
  });
});

describe("TerminalStore data and lifecycle", () => {
  it("drops data at or below the replay boundary and acks accepted frames", async () => {
    const { store, calls, terms } = createStore(
      {},
      {
        async create() {
          return {
            kind: "ok",
            terminal: { id: "t-1", pid: 1, title: "bash", cwd: "/work/app", cols: 80, rows: 24 },
            replay: { data: "", bytes: 0, seq: 4 },
          };
        },
      },
    );
    await store.getState().create("tab-1", "/work/app", 80, 24);

    store.getState().handleData("t-1", new TextEncoder().encode("old"), 4);
    expect(terms[0]!.writes).toHaveLength(0);

    store.getState().handleData("t-1", new TextEncoder().encode("new"), 5);
    expect(terms[0]!.writes).toHaveLength(1);
    expect(calls.ack).toEqual([["t-1", 3]]);
    expect(store.getState().forTab("tab-1")?.lastSeq).toBe(5);

    store.getState().handleData("unknown", new Uint8Array([1]), 1);
  });

  it("updates the exit and error state", async () => {
    const { store } = createStore();
    await store.getState().create("tab-1", "/work/app", 80, 24);
    store.getState().handleExit("t-1", 7, 15);
    expect(store.getState().forTab("tab-1")).toMatchObject({
      status: "exited",
      exitCode: 7,
      error: "the shell exited (signal 15)",
    });

    store.getState().handleError("t-1", "host died");
    expect(store.getState().forTab("tab-1")).toMatchObject({
      status: "failed",
      error: "host died",
    });
  });

  it("forwards input and resize, skipping a no-op resize", async () => {
    const { store, calls } = createStore();
    await store.getState().create("tab-1", "/work/app", 80, 24);
    store.getState().write("tab-1", "ls\r");
    expect(calls.write).toEqual([["t-1", "ls\r"]]);

    store.getState().resize("tab-1", 100, 40);
    store.getState().resize("tab-1", 100, 40);
    expect(calls.resize).toEqual([["t-1", 100, 40]]);
    expect(store.getState().forTab("tab-1")).toMatchObject({ cols: 100, rows: 40 });
  });

  it("closes and forgets a terminal, disposing the xterm", async () => {
    const { store, calls, pool, terms } = createStore();
    await store.getState().create("tab-1", "/work/app", 80, 24);
    await store.getState().close("tab-1");
    expect(calls.close).toEqual(["t-1"]);
    expect(pool.has("t-1")).toBe(false);
    expect(terms[0]!.disposed).toBe(1);
    expect(store.getState().forTab("tab-1")).toBeUndefined();
  });

  it("closes the shell when the tab is removed", async () => {
    const { store, calls, pool } = createStore();
    await store.getState().create("tab-1", "/work/app", 80, 24);
    store.getState().removeTab("tab-1");
    expect(calls.close).toEqual(["t-1"]);
    expect(pool.has("t-1")).toBe(false);
  });

  it("recreates the xterm and replays when the view remounts after a reload", async () => {
    const replayBytes = new TextEncoder().encode("tail");
    const { store, pool, terms } = createStore(
      {},
      {
        async attach() {
          return { data: bytesToBase64(replayBytes), bytes: replayBytes.length, seq: 9 };
        },
      },
    );
    await store.getState().create("tab-1", "/work/app", 80, 24);
    // A new renderer has an empty pool; the host still has the shell.
    pool.dispose("t-1");
    expect(pool.has("t-1")).toBe(false);

    await expect(store.getState().reattach("tab-1", "/work/app")).resolves.toBe(true);
    expect(pool.has("t-1")).toBe(true);
    expect(Array.from(terms.at(-1)!.writes[0]!)).toEqual(Array.from(replayBytes));
    expect(store.getState().forTab("tab-1")?.lastSeq).toBe(9);
  });

  it("reattaches a live terminal and reports a vanished one", async () => {
    const { store, calls, pool } = createStore();
    await store.getState().create("tab-1", "/work/app", 80, 24);

    await expect(store.getState().reattach("tab-1", "/work/app")).resolves.toBe(true);
    expect(calls.attach).toEqual(["t-1"]);

    const gone = createStore(
      {},
      {
        async attach() {
          return null;
        },
      },
    );
    await gone.store.getState().create("tab-1", "/work/app", 80, 24);
    await expect(gone.store.getState().reattach("tab-1", "/work/app")).resolves.toBe(false);
    expect(gone.store.getState().forTab("tab-1")).toMatchObject({
      terminalId: null,
      status: "exited",
    });
    expect(pool.has("t-1")).toBe(true);
  });
});
