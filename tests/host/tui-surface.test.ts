import { describe, expect, it, vi } from "vitest";
import { stripAnsi, visibleWidth } from "../../src/shared/ansi";
import { TUI_STATE_EVENT, type TuiSurfaceSnapshot } from "../../src/shared/tui-surface";
import {
  createTuiSurface,
  resolveOverlayLayout,
  type SurfaceComponent,
  type TuiRenderKit,
} from "../../src/host/tui-surface";

/**
 * The host TUI surface (plan step 17).
 *
 * This is the emulated `TUI` extensions receive from `ctx.ui.custom()`. What
 * matters: a component's render reaches the wire as ANSI lines, focus decides
 * who receives input, an overlay resolves its geometry the way pi-tui does, and
 * a disposed/undefined component never rejects a pending extension.
 */

const CURSOR = "\x1b_pi:c\x07";

const kit: TuiRenderKit = {
  visibleWidth,
  sliceByColumn: (line, start, length) => line.slice(start, start + length),
  stripTerminalSequences: (text) => stripAnsi(text),
  cursorMarker: CURSOR,
};

function component(
  render: (width: number) => string[],
  handleInput?: (data: string) => void,
): SurfaceComponent {
  return { render, ...(handleInput ? { handleInput } : {}) };
}

function harness() {
  const events: Array<{ event: string; payload?: unknown }> = [];
  const terminalInput: Array<(data: string) => { consume?: boolean; data?: string } | undefined> =
    [];
  const port = createTuiSurface({
    emit: (event, payload) => events.push({ event, ...(payload === undefined ? {} : { payload }) }),
    terminalInput: () => terminalInput,
    kit,
    defaultRows: 24,
    defaultCols: 80,
  });
  const frames = (): TuiSurfaceSnapshot[] =>
    events
      .filter((entry) => entry.event === TUI_STATE_EVENT)
      .map((entry) => entry.payload as TuiSurfaceSnapshot);
  return { port, events, frames, terminalInput };
}

const tick = async (): Promise<void> => {
  // The surface mounts inside a microtask chain and then schedules its render on
  // a timer, so flush the chain before letting timers run.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("tui surface custom components", () => {
  it("mounts a custom component, emits a frame, then clears on done", async () => {
    const { port, frames } = harness();
    let done: ((result: string) => void) | undefined;
    const pending = port.custom<string>((_tui, finish) => {
      done = finish;
      return component(() => ["\x1b[32mhello\x1b[0m"]);
    });
    await tick();
    expect(frames().at(-1)?.custom?.lines).toEqual(["\x1b[32mhello\x1b[0m"]);
    expect(frames().at(-1)?.active).toBe(true);
    expect(frames().at(-1)?.focus).toBe("custom");

    done?.("picked");
    await expect(pending).resolves.toBe("picked");
    await tick();
    expect(frames().at(-1)?.custom).toBeNull();
    expect(frames().at(-1)?.active).toBe(false);
  });

  it("resolves undefined (never crashes) when the factory returns undefined", async () => {
    const { port } = harness();
    const result = await port.custom<string>(() => undefined as unknown as SurfaceComponent);
    expect(result).toBeUndefined();
  });

  it("rejects a factory that throws by resolving undefined", async () => {
    const { port } = harness();
    await expect(
      port.custom<string>(() => {
        throw new Error("boom");
      }),
    ).resolves.toBeUndefined();
  });

  it("extracts and strips the cursor marker for the focused component", async () => {
    const { port, frames } = harness();
    const pending = port.custom<string>(() => component(() => [`ab${CURSOR}cd`]));
    await tick();
    const frame = frames().at(-1)?.custom;
    expect(frame?.cursor).toEqual({ row: 0, col: 2 });
    expect(frame?.lines).toEqual(["abcd"]);
    void pending;
  });

  it("honours a 12-row terminal", async () => {
    const { port, frames } = harness();
    port.setSize(12, 40);
    const pending = port.custom<string>(() => component((width) => [`w=${width}`]));
    await tick();
    const frame = frames().at(-1)?.custom;
    expect(frame?.width).toBe(40);
    expect(frame?.lines).toEqual(["w=40"]);
    void pending;
  });
});

describe("tui surface input", () => {
  it("routes input to the focused component", async () => {
    const { port } = harness();
    const seen: string[] = [];
    const pending = port.custom<string>(() =>
      component(
        () => ["x"],
        (data) => seen.push(data),
      ),
    );
    await tick();
    port.input("\x1b[B");
    expect(seen).toEqual(["\x1b[B"]);
    void pending;
  });

  it("consults extension onTerminalInput handlers first and honours consume", async () => {
    const { port, terminalInput } = harness();
    const seen: string[] = [];
    const consumed: string[] = [];
    terminalInput.push((data) => {
      if (data === "q") {
        consumed.push(data);
        return { consume: true };
      }
      return undefined;
    });
    const pending = port.custom<string>(() =>
      component(
        () => ["x"],
        (data) => seen.push(data),
      ),
    );
    await tick();
    port.input("q");
    port.input("a");
    expect(consumed).toEqual(["q"]);
    expect(seen).toEqual(["a"]);
    void pending;
  });

  it("reports consumption through tui.input so Escape can skip stopRun", async () => {
    const { port, terminalInput } = harness();
    terminalInput.push((data) => (data === "\x1b" ? { consume: true } : undefined));
    const handlers = port.handlers();

    const consumed = handlers["tui.input"]?.({ data: "\x1b" }, {} as never);
    expect(consumed).toEqual({ ok: true, consumed: true, dispatched: true });

    // Nothing claims a plain letter and no component is focused: delivered
    // nowhere, so the renderer must not treat it as an interruption.
    const untouched = handlers["tui.input"]?.({ data: "z" }, {} as never);
    expect(untouched).toEqual({ ok: true, consumed: false, dispatched: false });
  });

  it("reports consumption by a TUI input listener, not just an extension filter", async () => {
    const { port } = harness();
    const pending = port.custom<string>((tui) => {
      tui.addInputListener((data) => (data === "\x1b" ? { consume: true } : undefined));
      return component(() => ["x"]);
    });
    await tick();
    expect(port.handlers()["tui.input"]?.({ data: "\x1b" }, {} as never)).toEqual({
      ok: true,
      consumed: true,
      dispatched: true,
    });
    void pending;
  });

  it("applies data transformations before the component sees the key", async () => {
    const { port, terminalInput } = harness();
    const seen: string[] = [];
    terminalInput.push((data) => (data === "j" ? { data: "\x1b[B" } : undefined));
    const pending = port.custom<string>(() =>
      component(
        () => ["x"],
        (data) => seen.push(data),
      ),
    );
    await tick();
    expect(port.handlers()["tui.input"]?.({ data: "j" }, {} as never)).toEqual({
      ok: true,
      consumed: false,
      dispatched: true,
    });
    expect(seen).toEqual(["\x1b[B"]);
    void pending;
  });

  it("a throwing handler neither escapes nor loses the key", async () => {
    const { port, terminalInput } = harness();
    const seen: string[] = [];
    terminalInput.push(() => {
      throw new Error("broken extension");
    });
    const pending = port.custom<string>(() =>
      component(
        () => ["x"],
        (data) => seen.push(data),
      ),
    );
    await tick();
    expect(() => port.handlers()["tui.input"]?.({ data: "\x1b" }, {} as never)).not.toThrow();
    expect(seen).toEqual(["\x1b"]);
    void pending;
  });
});

describe("tui surface overlays", () => {
  it("resolves overlay bounds and exposes them through the handle", async () => {
    const { port, frames } = harness();
    const pending = port.custom<string>(() => component(() => ["overlay"]), {
      overlay: true,
      overlayOptions: { width: 20, anchor: "center" },
    });
    await tick();
    const snapshot = frames().at(-1);
    expect(snapshot?.overlay).toBe(true);
    expect(snapshot?.bounds).toMatchObject({ width: 20, height: 1 });
    void pending;
  });

  it("hides an overlay and restores focus", async () => {
    const { port, frames } = harness();
    let handle: { setHidden(hidden: boolean): void; isHidden(): boolean } | undefined;
    const pending = port.custom<string>(() => component(() => ["o"]), {
      overlay: true,
      overlayOptions: { width: 10 },
      onHandle: (h) => (handle = h),
    });
    await tick();
    handle?.setHidden(true);
    await tick();
    expect(frames().at(-1)?.overlay).toBe(false);
    expect(handle?.isHidden()).toBe(true);
    void pending;
  });

  it("honours an overlay's visible() against the terminal size", async () => {
    const { port, frames } = harness();
    const pending = port.custom<string>(() => component(() => ["o"]), {
      overlay: true,
      overlayOptions: { width: 10, visible: (_w, h) => h >= 20 },
    });
    await tick();
    expect(frames().at(-1)?.overlay).toBe(true);
    port.setSize(12, 80);
    await tick();
    expect(frames().at(-1)?.overlay).toBe(false);
    void pending;
  });
});

describe("tui surface slots", () => {
  it("renders header and footer components without taking the composer", async () => {
    const { port, frames } = harness();
    port.setHeader(() => component(() => ["HEAD"]));
    port.setFooter(() => component(() => ["FOOT"]));
    await tick();
    const snapshot = frames().at(-1);
    expect(snapshot?.header?.lines).toEqual(["HEAD"]);
    expect(snapshot?.footer?.lines).toEqual(["FOOT"]);
    expect(snapshot?.focus).toBeNull();
    // The wire has no editor slot at all: the native composer is the editor.
    expect(snapshot && "editor" in snapshot).toBe(false);
  });

  it("invalidates every component on request", async () => {
    const { port } = harness();
    const invalidate = vi.fn();
    port.setFooter(() => ({ render: () => ["f"], invalidate }));
    await tick();
    port.invalidate();
    expect(invalidate).toHaveBeenCalled();
  });
});

describe("tui surface widgets (2026-10-26 plan, step 5)", () => {
  it("renders, replaces and disposes a component widget above the editor", async () => {
    const { port, frames } = harness();
    port.setSize(20, 40);
    const firstDispose = vi.fn();
    port.setWidget("w", () => ({ render: () => ["first"], dispose: firstDispose }), "aboveEditor");
    await tick();
    expect(frames().at(-1)?.widgetsAbove[0]?.lines).toEqual(["first"]);

    const secondDispose = vi.fn();
    port.setWidget(
      "w",
      () => ({ render: () => ["second"], dispose: secondDispose }),
      "aboveEditor",
    );
    await tick();
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(frames().at(-1)?.widgetsAbove[0]?.lines).toEqual(["second"]);

    port.setWidget("w", undefined, "aboveEditor");
    await tick();
    expect(secondDispose).toHaveBeenCalledTimes(1);
    expect(frames().at(-1)?.widgetsAbove).toEqual([]);
  });

  it("places widgets above or below and invalidates them", async () => {
    const { port, frames } = harness();
    const invalidate = vi.fn();
    port.setWidget("below", () => ({ render: () => ["below"], invalidate }), "belowEditor");
    port.setWidget("above", () => ({ render: () => ["above"] }), "aboveEditor");
    await tick();
    expect(frames().at(-1)?.widgetsBelow[0]?.lines).toEqual(["below"]);
    expect(frames().at(-1)?.widgetsAbove[0]?.lines).toEqual(["above"]);

    port.invalidate();
    expect(invalidate).toHaveBeenCalled();
  });

  it("clears widgets on reset and ignores a throwing factory", async () => {
    const { port, frames } = harness();
    const dispose = vi.fn();
    port.setWidget("w", () => ({ render: () => ["w"], dispose }), "aboveEditor");
    port.setWidget(
      "bad",
      () => {
        throw new Error("boom");
      },
      "aboveEditor",
    );
    await tick();
    expect(frames().at(-1)?.widgetsAbove).toHaveLength(1);

    port.reset();
    await tick();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(frames().at(-1)?.widgetsAbove).toEqual([]);
  });
});

describe("tui surface handlers", () => {
  it("answers tui.state and validates tui.resize/tui.input", async () => {
    const { port } = harness();
    const handlers = port.handlers();
    expect(handlers["tui.state"]?.({}, {} as never)).toMatchObject({ active: false });
    expect(handlers["tui.resize"]?.({ rows: 12, cols: 40 }, {} as never)).toEqual({
      ok: true,
      rows: 12,
      cols: 40,
    });
    expect(() => handlers["tui.resize"]?.({ rows: 0, cols: 40 }, {} as never)).toThrow();
    expect(handlers["tui.input"]?.({ data: "a" }, {} as never)).toEqual({
      ok: true,
      consumed: false,
      dispatched: false,
    });
    expect(() => handlers["tui.input"]?.({}, {} as never)).toThrow();
  });

  it("resolves pending custom components on dispose", async () => {
    const { port } = harness();
    const pending = port.custom<string>(() => component(() => ["x"]));
    await tick();
    port.dispose("test");
    await expect(pending).resolves.toBeUndefined();
  });
});

describe("tui surface viewport contract (2026-10-26 plan, step 1)", () => {
  it("keeps terminal rows independent of the component's rendered height", async () => {
    const { port, frames } = harness();
    port.setSize(60, 150);
    const pending = port.custom<string>((tui) =>
      component(() =>
        Array.from({ length: Math.max(1, tui.terminal.rows) }, (_, index) => `row ${index}`),
      ),
    );
    await tick();
    expect(frames().at(-1)?.custom?.height).toBe(60);

    // A second render must see the same terminal, not the first frame's height.
    port.setSize(60, 150);
    await tick();
    expect(frames().at(-1)?.custom?.height).toBe(60);
    void pending;
  });

  it("resolves the questionnaire's bottom sheet against the full viewport", async () => {
    const { port, frames } = harness();
    port.setSize(60, 150);
    const pending = port.custom<string>(
      (tui) => {
        const rows = Math.max(1, Math.floor(tui.terminal.rows));
        const maxRows = Math.max(1, Math.min(32, Math.floor(rows * 0.8) - 1));
        return component(() => Array.from({ length: maxRows }, (_, index) => `q${index}`));
      },
      {
        overlay: true,
        overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "80%", margin: 0 },
      },
    );
    await tick();
    const snapshot = frames().at(-1);
    expect(snapshot?.custom?.lines).toHaveLength(32);
    expect(snapshot?.bounds).toMatchObject({ row: 28, col: 0, width: 150, height: 32 });
    void pending;
  });
});

describe("resolveOverlayLayout", () => {
  it("defaults to a centred 80-wide overlay clamped to the terminal", () => {
    expect(resolveOverlayLayout(undefined, 4, 100, 40)).toMatchObject({ width: 80 });
    expect(resolveOverlayLayout(undefined, 4, 50, 40).width).toBe(50);
  });

  it("honours anchors, margins, percentages and maxHeight", () => {
    expect(
      resolveOverlayLayout({ width: "50%", anchor: "top-left", margin: 2 }, 3, 100, 40),
    ).toEqual({ width: 50, row: 2, col: 2, maxHeight: undefined });
    expect(resolveOverlayLayout({ width: 20, anchor: "bottom-right" }, 2, 100, 40)).toMatchObject({
      row: 38,
      col: 80,
    });
    expect(resolveOverlayLayout({ width: 20, maxHeight: 2 }, 10, 100, 40).maxHeight).toBe(2);
    expect(resolveOverlayLayout({ width: 20, minWidth: 30 }, 1, 100, 40).width).toBe(30);
  });

  it("clamps offsets inside the terminal bounds", () => {
    expect(
      resolveOverlayLayout({ width: 20, offsetX: 1000, offsetY: 1000 }, 2, 100, 40),
    ).toMatchObject({ row: 38, col: 80 });
  });
});
