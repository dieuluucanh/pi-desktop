import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalView } from "../../src/renderer/src/views/TerminalView";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { createTerminalStore } from "../../src/renderer/src/state/terminal-store";
import {
  TerminalPool,
  type PoolTerminal,
  type TerminalOptionsPatch,
  type TerminalPoolOptions,
} from "../../src/renderer/src/terminal/terminal-pool";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type {
  TerminalBridge,
  TerminalCreateInput,
  TerminalCreateOutcome,
} from "../../src/shared/terminal-ipc";
import type { TerminalInfo } from "../../src/shared/terminal-protocol";
import { terminalThemeFromCssVariables } from "../../src/shared/terminal-theme";

const TAB = { id: "tab-1", cwd: "/work/app", profileId: null };

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
  readonly pasted: string[] = [];
  readonly optionPatches: TerminalOptionsPatch[] = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly selectionListeners = new Set<() => void>();
  private readonly bellListeners = new Set<() => void>();
  selection = "";
  keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  fitCalls = 0;
  fitSize = { cols: 80, rows: 24 };

  write(bytes: Uint8Array, callback?: () => void): void {
    this.writes.push(bytes);
    callback?.();
  }
  focus(): void {}
  dispose(): void {}
  fit(): { cols: number; rows: number } {
    this.fitCalls += 1;
    return this.fitSize;
  }
  getSelection(): string {
    return this.selection;
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
  setOptions(options: TerminalOptionsPatch): void {
    this.optionPatches.push(options);
  }
  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }
  attachKeyHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }
  paste(text: string): void {
    this.pasted.push(text);
  }
  onTitleChange(): () => void {
    return () => undefined;
  }
  onSelectionChange(listener: () => void): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }
  onBell(listener: () => void): () => void {
    this.bellListeners.add(listener);
    return () => this.bellListeners.delete(listener);
  }
  emit(text: string): void {
    for (const listener of this.dataListeners) listener(text);
  }
  emitSelection(text: string): void {
    this.selection = text;
    for (const listener of this.selectionListeners) listener();
  }
  emitBell(): void {
    for (const listener of this.bellListeners) listener();
  }
}

function setup(outcome?: TerminalCreateOutcome) {
  const terms: FakeTerm[] = [];
  const creates: TerminalCreateInput[] = [];
  const pool = new TerminalPool({
    create() {
      const term = new FakeTerm();
      terms.push(term);
      return term;
    },
  });
  const writes: Array<[string, string]> = [];
  const resizes: Array<[string, number, number]> = [];
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
      creates.push(input);
      return (
        outcome ?? {
          kind: "ok",
          terminal: { ...info, cols: input.cols, rows: input.rows },
          replay: { data: "", bytes: 0, seq: 0 },
        }
      );
    },
    async attach() {
      return { data: "", bytes: 0, seq: 0 };
    },
    async write(terminalId, data) {
      writes.push([terminalId, data]);
    },
    async resize(terminalId, cols, rows) {
      resizes.push([terminalId, cols, rows]);
    },
    async close() {
      return true;
    },
    ack() {},
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
  };
  const store = createTerminalStore({
    bridge,
    pool,
    options: poolOptions,
    requestTrust: async () => false,
  });
  return { store, pool, terms, writes, resizes, creates };
}

describe("TerminalView", () => {
  beforeEach(() => {
    useAppStore.setState({ prefs: { ...DEFAULT_PREFS } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setTerminalPrefs(patch: Partial<typeof DEFAULT_PREFS.terminal>): void {
    const current = useAppStore.getState().prefs.terminal;
    act(() => useAppStore.getState().setPrefs({ terminal: { ...current, ...patch } }));
  }

  it("creates the shell, mounts the pooled xterm and forwards input", async () => {
    const { store, pool, terms, writes } = setup();
    render(
      <TerminalView
        tab={TAB}
        store={store}
        pool={pool}
        requestTrust={async () => false}
        platform="linux"
      />,
    );

    await waitFor(() => expect(store.getState().forTab(TAB.id)?.status).toBe("attached"));
    const host = screen.getByTestId("terminal-host");
    expect(host.contains(terms[0]!.element)).toBe(true);
    expect(pool.has("t-1")).toBe(true);

    act(() => terms[0]!.emit("ls\r"));
    await waitFor(() => expect(writes).toEqual([["t-1", "ls\r"]]));
  });

  it("forwards the tab's shell profile to the terminal service", async () => {
    const { store, pool, creates } = setup();
    render(
      <TerminalView
        tab={{ ...TAB, profileId: "git-bash" }}
        store={store}
        pool={pool}
        requestTrust={async () => false}
        platform="linux"
      />,
    );

    await waitFor(() => expect(store.getState().forTab(TAB.id)?.status).toBe("attached"));
    expect(creates[0]).toMatchObject({ tabId: TAB.id, profileId: "git-bash" });
  });

  it("applies font and appearance changes to the live terminal", async () => {
    const { store, pool, terms } = setup();
    render(
      <TerminalView
        tab={TAB}
        store={store}
        pool={pool}
        requestTrust={async () => false}
        platform="linux"
      />,
    );
    await waitFor(() => expect(store.getState().forTab(TAB.id)?.status).toBe("attached"));

    setTerminalPrefs({ fontSize: 18, fontFamily: "Consolas, monospace" });
    await waitFor(() =>
      expect(
        terms[0]!.optionPatches.some(
          (options) => options.fontSize === 18 && options.fontFamily === "Consolas, monospace",
        ),
      ).toBe(true),
    );
    expect(terms[0]!.optionPatches.some((options) => options.fontFamily?.includes("var("))).toBe(
      false,
    );
  });

  it("copies a settled selection when copy-on-selection is enabled", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { store, pool, terms } = setup();
    render(
      <TerminalView
        tab={TAB}
        store={store}
        pool={pool}
        requestTrust={async () => false}
        platform="linux"
      />,
    );
    await waitFor(() => expect(store.getState().forTab(TAB.id)?.status).toBe("attached"));

    setTerminalPrefs({ copyOnSelection: true });
    act(() => terms[0]!.emitSelection("hello"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("hello"));
  });

  it("flashes the surface on BEL only when the bell preference is on", async () => {
    const { store, pool, terms } = setup();
    render(
      <TerminalView
        tab={TAB}
        store={store}
        pool={pool}
        requestTrust={async () => false}
        platform="linux"
      />,
    );
    await waitFor(() => expect(store.getState().forTab(TAB.id)?.status).toBe("attached"));

    act(() => terms[0]!.emitBell());
    expect(screen.getByTestId("terminal-view")).not.toHaveAttribute("data-bell");

    setTerminalPrefs({ enableBell: true });
    act(() => terms[0]!.emitBell());
    expect(screen.getByTestId("terminal-view")).toHaveAttribute("data-bell", "true");
    await waitFor(() =>
      expect(screen.getByTestId("terminal-view")).not.toHaveAttribute("data-bell"),
    );
  });

  it("shows a Restart notice when the shell exits", async () => {
    const { store, pool } = setup();
    render(
      <TerminalView
        tab={TAB}
        store={store}
        pool={pool}
        requestTrust={async () => false}
        platform="linux"
      />,
    );
    await waitFor(() => expect(store.getState().forTab(TAB.id)?.status).toBe("attached"));

    act(() => store.getState().handleExit("t-1", 7));
    expect(await screen.findByText(/Terminal exited/)).toBeTruthy();
    expect(screen.getByText("Restart")).toBeTruthy();
  });

  it("asks for trust instead of spawning an untrusted shell", async () => {
    const { store, pool } = setup({ kind: "needs-trust", cwd: "/work/app" });
    render(
      <TerminalView
        tab={TAB}
        store={store}
        pool={pool}
        requestTrust={async () => false}
        platform="linux"
      />,
    );

    await waitFor(() => expect(screen.getByText(/This project is not trusted/)).toBeTruthy());
    expect(screen.getByText("Trust project…")).toBeTruthy();
    expect(store.getState().forTab(TAB.id)?.status).toBe("needs-trust");
  });

  it("shows the failure message and a Retry button", async () => {
    const { store, pool } = setup({
      kind: "error",
      code: "spawn_failed",
      message: "no shell found",
    });
    render(
      <TerminalView
        tab={TAB}
        store={store}
        pool={pool}
        requestTrust={async () => false}
        platform="linux"
      />,
    );

    expect(await screen.findByText("no shell found")).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("puts the native-loader report behind Details and copies it", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const details = [
      "platform: linux x64 · node v24.22.2 · terminal protocol 1",
      "node-pty: not loaded — version `GLIBC_2.42' not found",
      "  /app/node-pty/build/Release/pty.node: version `GLIBC_2.42' not found",
      "log: /home/me/.pi/agent/logs/terminal.log",
    ].join("\n");
    const { store, pool } = setup({
      kind: "error",
      code: "native_unavailable",
      message: "The terminal backend could not start: node-pty could not be loaded",
      details,
    });
    render(
      <TerminalView
        tab={TAB}
        store={store}
        pool={pool}
        requestTrust={async () => false}
        platform="linux"
      />,
    );

    expect(await screen.findByText(/terminal backend could not start/i)).toBeTruthy();
    expect(screen.getByText("Details")).toBeTruthy();
    expect(screen.getByText(/GLIBC_2\.42/)).toBeTruthy();

    fireEvent.click(screen.getByText("Copy details"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain("terminal backend could not start");
    expect(writeText.mock.calls[0]?.[0]).toContain("terminal.log");
    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
  });

  it("skips fitting while the host has no layout box", async () => {
    class FakeResizeObserver {
      static latest: FakeResizeObserver | undefined;
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        FakeResizeObserver.latest = this;
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      trigger(): void {
        this.callback([], this as unknown as ResizeObserver);
      }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    const { store, pool, terms, resizes } = setup();
    render(
      <TerminalView
        tab={TAB}
        store={store}
        pool={pool}
        requestTrust={async () => false}
        platform="linux"
      />,
    );
    await waitFor(() => expect(store.getState().forTab(TAB.id)?.status).toBe("attached"));

    const host = screen.getByTestId("terminal-host");
    Object.defineProperty(host, "clientWidth", { configurable: true, value: 0 });
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 0 });
    const observer = FakeResizeObserver.latest!;
    const before = terms[0]!.fitCalls;
    act(() => observer.trigger());
    expect(terms[0]!.fitCalls).toBe(before);
    expect(resizes).toHaveLength(0);

    Object.defineProperty(host, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 600 });
    terms[0]!.fitSize = { cols: 100, rows: 40 };
    act(() => observer.trigger());
    expect(terms[0]!.fitCalls).toBe(before + 1);
    await waitFor(() => expect(resizes).toEqual([["t-1", 100, 40]]));
  });
});
