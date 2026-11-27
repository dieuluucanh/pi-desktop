import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import type { TerminalKeyPlatform } from "../../src/shared/terminal-keys";
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
  wheelHandler: ((event: WheelEvent) => boolean) | null = null;
  buffer: "normal" | "alternate" = "normal";
  mouseWheelReporting = false;
  fitCalls = 0;
  fitSize = { cols: 80, rows: 24 };

  constructor() {
    // xterm binds its own `paste` listener to the helper textarea and to the
    // `.xterm` element (browser/Clipboard.ts handlePasteEvent): a native paste
    // that reaches this element becomes a PTY write. Emulated so a test can see
    // the third writer the browser adds when nothing cancels the DOM default.
    this.element.addEventListener("paste", (event) => {
      const text = (event as ClipboardEvent).clipboardData?.getData("text/plain") ?? "";
      event.stopPropagation();
      if (text.length > 0) this.paste(text);
    });
  }

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
  bufferType(): "normal" | "alternate" {
    return this.buffer;
  }
  mouseWheelReports(): boolean {
    return this.mouseWheelReporting;
  }
  attachWheelHandler(handler: (event: WheelEvent) => boolean): void {
    this.wheelHandler = handler;
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

  /** The clipboard the async clipboard API returns, with copy counted too. */
  function stubClipboard(text: string): {
    readText: ReturnType<typeof vi.fn>;
    writeText: ReturnType<typeof vi.fn>;
  } {
    const clipboard = {
      readText: vi.fn().mockResolvedValue(text),
      writeText: vi.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    return clipboard;
  }

  /** Mounts the view and returns the pooled fake terminal plus its host. */
  async function mountTerminal(platform: TerminalKeyPlatform = "linux") {
    const harness = setup();
    const view = render(
      <TerminalView
        tab={TAB}
        store={harness.store}
        pool={harness.pool}
        requestTrust={async () => false}
        platform={platform}
      />,
    );
    await waitFor(() => expect(harness.store.getState().forTab(TAB.id)?.status).toBe("attached"));
    return {
      ...harness,
      unmount: view.unmount,
      host: screen.getByTestId("terminal-host"),
      term: harness.terms[0]!,
    };
  }

  /** Lets the app's `await navigator.clipboard.readText()` writes settle. */
  async function settlePastes(): Promise<void> {
    await act(async () => {
      // Each `await` in the paste path adds a tick; flush a few so a late write
      // can never land after the assertion and hide a duplicate.
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    });
  }

  /**
   * One clipboard gesture as Chromium runs it around xterm: xterm asks the
   * custom key handler about keydown, keypress and keyup; unless the keydown was
   * defaultPrevented the browser also runs its paste command, which lands on
   * xterm's helper textarea (emulated by FakeTerm's own `paste` listener).
   *
   * Chromium fires `keypress` only for character-producing keys, so a Ctrl/Cmd
   * chord and a named key such as Insert do not get one.
   */
  function pressChord(term: FakeTerm, init: KeyboardEventInit, clipboard: string): KeyboardEvent {
    const down = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    term.keyHandler?.(down);
    if (!down.defaultPrevented) {
      fireEvent.paste(term.element, { clipboardData: { getData: () => clipboard } });
    }
    const keypress = init.key?.length === 1 && !init.ctrlKey && !init.metaKey && !init.altKey;
    for (const type of [...(keypress ? (["keypress"] as const) : []), "keyup"] as const) {
      term.keyHandler?.(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
    }
    return down;
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

  it("pastes the clipboard exactly once for Ctrl+V", async () => {
    stubClipboard("hello");
    const { term } = await mountTerminal("win32");

    const down = pressChord(term, { key: "v", ctrlKey: true }, "hello");
    await settlePastes();

    expect(term.pasted).toEqual(["hello"]);
    expect(down.defaultPrevented).toBe(true);
  });

  it("pastes the clipboard once for Ctrl+Shift+V", async () => {
    stubClipboard("hello");
    const { term } = await mountTerminal("linux");

    pressChord(term, { key: "V", ctrlKey: true, shiftKey: true }, "hello");
    await settlePastes();

    expect(term.pasted).toEqual(["hello"]);
  });

  it("pastes the clipboard once for Cmd+V on macOS", async () => {
    stubClipboard("hello");
    const { term } = await mountTerminal("darwin");

    pressChord(term, { key: "v", metaKey: true }, "hello");
    await settlePastes();

    expect(term.pasted).toEqual(["hello"]);
  });

  it("never repeats a paste on keypress or keyup", async () => {
    stubClipboard("hello");
    const { term } = await mountTerminal("win32");

    for (const type of ["keypress", "keyup"] as const) {
      term.keyHandler?.(
        new KeyboardEvent(type, { bubbles: true, cancelable: true, key: "v", ctrlKey: true }),
      );
    }
    await settlePastes();

    expect(term.pasted).toEqual([]);
  });

  it("writes a native paste once and cancels its DOM default", async () => {
    stubClipboard("hello");
    const { term } = await mountTerminal("win32");

    // The context menu / Edit ▸ Paste path: the browser fires `paste` on the
    // helper textarea, which xterm would normally turn into a PTY write itself.
    const event = createEvent.paste(term.element, {
      clipboardData: { getData: () => "from-menu" },
    });
    fireEvent(term.element, event);
    await settlePastes();

    expect(term.pasted).toEqual(["from-menu"]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("collapses a native paste and a chord carrying the same text", async () => {
    stubClipboard("hello");
    const { term } = await mountTerminal("win32");

    // The macOS ordering: the menu accelerator pastes natively, then the
    // renderer's keydown reads the same clipboard text.
    fireEvent.paste(term.element, { clipboardData: { getData: () => "hello" } });
    pressChord(term, { key: "v", ctrlKey: true }, "hello");
    await settlePastes();

    expect(term.pasted).toEqual(["hello"]);
  });

  it("writes two deliberate chord pastes", async () => {
    stubClipboard("hello");
    const { term } = await mountTerminal("win32");

    pressChord(term, { key: "v", ctrlKey: true }, "hello");
    await settlePastes();
    pressChord(term, { key: "v", ctrlKey: true }, "hello");
    await settlePastes();

    expect(term.pasted).toEqual(["hello", "hello"]);
  });

  it("copies the selection on Ctrl+Shift+C and cancels the browser copy", async () => {
    const { writeText } = stubClipboard("unused");
    const { term } = await mountTerminal("win32");
    act(() => term.emitSelection("picked"));

    const down = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "C",
      ctrlKey: true,
      shiftKey: true,
    });
    term.keyHandler?.(down);
    await settlePastes();

    expect(down.defaultPrevented).toBe(true);
    expect(writeText).toHaveBeenCalledWith("picked");
    expect(term.pasted).toEqual([]);
  });

  it("pastes from the Paste button once", async () => {
    stubClipboard("hello");
    const { term } = await mountTerminal("win32");

    fireEvent.click(screen.getByText("Paste"));
    await settlePastes();

    expect(term.pasted).toEqual(["hello"]);
  });

  it("ignores an empty clipboard", async () => {
    stubClipboard("");
    const { term } = await mountTerminal("win32");

    fireEvent.paste(term.element, { clipboardData: { getData: () => "" } });
    fireEvent.click(screen.getByText("Paste"));
    await settlePastes();

    expect(term.pasted).toEqual([]);
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

  describe("mouse wheel", () => {
    function wheel(init: WheelEventInit = {}): WheelEvent {
      return new WheelEvent("wheel", { deltaY: 100, cancelable: true, bubbles: true, ...init });
    }

    it("pages the alternate screen instead of sending arrow keys", async () => {
      const { term, writes } = await mountTerminal();
      term.buffer = "alternate";

      const event = wheel({ deltaY: 120 });
      expect(term.wheelHandler?.(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => expect(writes).toEqual([["t-1", "\x1b[6~"]]));
    });

    it("sends one page per gesture and a page the other way on reversal", async () => {
      const { term, writes } = await mountTerminal();
      term.buffer = "alternate";

      act(() => term.wheelHandler?.(wheel({ deltaY: -120 })));
      await waitFor(() => expect(writes).toEqual([["t-1", "\x1b[5~"]]));

      // Same direction inside the burst window: swallowed, no second page.
      const repeat = wheel({ deltaY: -120 });
      expect(term.wheelHandler?.(repeat)).toBe(false);
      expect(repeat.defaultPrevented).toBe(true);
      expect(writes).toHaveLength(1);

      act(() => term.wheelHandler?.(wheel({ deltaY: 120 })));
      await waitFor(() =>
        expect(writes).toEqual([
          ["t-1", "\x1b[5~"],
          ["t-1", "\x1b[6~"],
        ]),
      );
    });

    it("leaves the normal screen and a wheel-reporting program to xterm", async () => {
      const { term, writes } = await mountTerminal();
      expect(term.wheelHandler?.(wheel())).toBe(true);

      term.buffer = "alternate";
      term.mouseWheelReporting = true;
      expect(term.wheelHandler?.(wheel())).toBe(true);
      expect(writes).toHaveLength(0);
    });

    it("swallows zoom and horizontal wheels without synthesizing a key", async () => {
      const { term, writes } = await mountTerminal();
      term.buffer = "alternate";

      for (const init of [{ ctrlKey: true }, { metaKey: true }, { deltaY: 0, deltaX: 80 }]) {
        const event = wheel(init);
        expect(term.wheelHandler?.(event)).toBe(false);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(writes).toHaveLength(0);
    });

    it("restores xterm's own handling when the view unmounts", async () => {
      const { term, unmount } = await mountTerminal();
      term.buffer = "alternate";
      unmount();

      const event = wheel();
      expect(term.wheelHandler?.(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    });
  });
});
