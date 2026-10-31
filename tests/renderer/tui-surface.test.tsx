import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TuiSlotFrame, TuiSurface } from "../../src/renderer/src/tui/TuiSurface";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { EMPTY_TUI_SURFACE, type TuiSurfaceSnapshot } from "../../src/shared/tui-surface";
import { installBridge } from "./fixtures";

/**
 * The interactive TUI surface (plan step 17; presentation amended 2026-10-26).
 *
 * What matters: a custom frame replaces the composer and takes the keyboard,
 * DOM keys become terminal bytes, a paste is bracketed, the host-issued cursor
 * is drawn, a bottom sheet is docked in flow with no backdrop, any other
 * overlay floats inside the session column, and an inactive surface renders
 * nothing. The grid is supplied by `SessionView`; this component never measures
 * itself (2026-10-26 plan, step 1).
 */

const TAB = "tab-1";
const CELL = { width: 8, height: 16 };
const GRID = { rows: 24, cols: 80 };

const originalClipboard = navigator.clipboard;

/** Replace the clipboard for one test; `copyText` prefers it over execCommand. */
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function selectFrame(): void {
  const frame = document.querySelector("[data-tui-frame]");
  if (!frame) throw new Error("no frame rendered");
  const range = document.createRange();
  range.selectNodeContents(frame);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function stubRequest(impl: (method: string, params?: unknown) => Promise<unknown>) {
  const request = vi.fn((input: { method: string; params?: unknown }) =>
    impl(input.method, input.params),
  );
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

function customFrame(overrides: Partial<TuiSurfaceSnapshot> = {}): TuiSurfaceSnapshot {
  return {
    ...EMPTY_TUI_SURFACE,
    active: true,
    focus: "custom",
    custom: {
      seq: 1,
      width: 30,
      height: 2,
      lines: ["Pick one", "> Build"],
      cursor: { row: 1, col: 2 },
    },
    ...overrides,
  };
}

function dock(frame: TuiSurfaceSnapshot, grid = GRID) {
  return <TuiSurface tabId={TAB} snapshot={frame} cell={CELL} grid={grid} variant="dock" />;
}

function float(frame: TuiSurfaceSnapshot, grid = GRID) {
  return <TuiSurface tabId={TAB} snapshot={frame} cell={CELL} grid={grid} variant="float" />;
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    tuiSurfaces: {},
  });
});

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
  window.getSelection()?.removeAllRanges();
});

describe("TuiSurface", () => {
  it("renders nothing when inactive", () => {
    const { container } = render(dock(EMPTY_TUI_SURFACE));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a custom frame, the cursor, and forwards keys as terminal bytes", () => {
    const request = stubRequest(async () => ({ ok: true }));
    render(dock(customFrame()));

    expect(screen.getByText("Pick one")).toBeInTheDocument();
    expect(document.querySelector("[data-tui-cursor]")).toBeTruthy();
    expect(document.querySelector('[data-tui-surface="dock"]')).toBeTruthy();

    fireEvent.keyDown(screen.getByLabelText("Extension input"), { key: "ArrowDown" });
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "tui.input",
      params: { data: "\x1b[B" },
    });
  });

  it("frames a paste as a bracketed paste", () => {
    const request = stubRequest(async () => ({ ok: true }));
    render(dock(customFrame()));
    fireEvent.paste(screen.getByLabelText("Extension input"), {
      clipboardData: { getData: () => "hello world" },
    });
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "tui.input",
      params: { data: "\x1b[200~hello world\x1b[201~" },
    });
  });

  it("copies a selected frame instead of forwarding Ctrl+C", () => {
    const request = stubRequest(async () => ({ ok: true }));
    const writeText = stubClipboard();
    render(dock(customFrame()));
    selectFrame();

    fireEvent.keyDown(screen.getByLabelText("Extension input"), { key: "c", ctrlKey: true });

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Pick one"));
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ method: "tui.input" }));
  });

  it("still forwards Ctrl+C when nothing is selected", () => {
    const request = stubRequest(async () => ({ ok: true }));
    const writeText = stubClipboard();
    render(dock(customFrame()));

    fireEvent.keyDown(screen.getByLabelText("Extension input"), { key: "c", ctrlKey: true });

    expect(writeText).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "tui.input",
      params: { data: "\x03" },
    });
  });

  it("copies the whole frame from the surface's Copy button", async () => {
    stubRequest(async () => ({ ok: true }));
    const writeText = stubClipboard();
    render(dock(customFrame()));

    fireEvent.click(screen.getByRole("button", { name: "Copy extension text" }));

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("Pick one\n> Build"));
  });

  it("copies the selection when the Copy button is used with one", () => {
    stubRequest(async () => ({ ok: true }));
    const writeText = stubClipboard();
    render(dock(customFrame()));
    selectFrame();

    fireEvent.click(screen.getByRole("button", { name: "Copy extension text" }));

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("> Build"));
  });

  it("forwards a plain wheel to the extension as an SGR sequence", () => {
    const request = stubRequest(async () => ({ ok: true }));
    render(dock(customFrame()));
    const scroller = document.querySelector(
      '[data-tui-surface="dock"] .overflow-y-auto',
    ) as HTMLElement;

    fireEvent.wheel(scroller, { deltaY: 40, clientX: 4, clientY: 8 });

    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "tui.input",
      params: { data: "\x1b[<65;1;1M" },
    });
  });

  it("scrolls locally only when the frame overflows its viewport", () => {
    const request = stubRequest(async () => ({ ok: true }));
    render(dock(customFrame()));
    const scroller = document.querySelector(
      '[data-tui-surface="dock"] .overflow-y-auto',
    ) as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", { value: 100, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 20, configurable: true });

    fireEvent.wheel(scroller, { deltaY: 50 });

    expect(scroller.scrollTop).toBe(50);
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ method: "tui.input" }));
  });

  it("forwards PageUp/PageDown when the frame fits", () => {
    const request = stubRequest(async () => ({ ok: true }));
    render(dock(customFrame()));

    fireEvent.keyDown(screen.getByLabelText("Extension input"), { key: "PageUp" });

    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "tui.input",
      params: { data: "\x1b[5~" },
    });
  });

  it("re-focuses the surface when the session reclaims the keyboard", () => {
    stubRequest(async () => ({ ok: true }));
    const snapshot = customFrame();
    const { rerender } = render(
      <TuiSurface
        tabId={TAB}
        snapshot={snapshot}
        cell={CELL}
        grid={GRID}
        variant="dock"
        focusToken={0}
      />,
    );
    const surface = document.querySelector('[data-tui-surface="dock"]') as HTMLElement;
    surface.blur();
    expect(surface).not.toHaveFocus();

    rerender(
      <TuiSurface
        tabId={TAB}
        snapshot={snapshot}
        cell={CELL}
        grid={GRID}
        variant="dock"
        focusToken={1}
      />,
    );

    expect(surface).toHaveFocus();
  });

  it("docks a bottom sheet in flow, with no backdrop and no page-level wrapper", () => {
    stubRequest(async () => ({ ok: true }));
    render(dock(customFrame()));

    const surface = document.querySelector('[data-tui-surface="dock"]');
    expect(surface).toBeTruthy();
    expect(document.querySelector("[data-tui-overlay]")).toBeNull();
    expect(document.querySelector(".bg-black\\/40")).toBeNull();
    expect(surface?.className).not.toContain("absolute");
    expect(surface?.className).toContain("border-t");
  });

  it("floats a non-bottom overlay inside the viewport from the host's bounds", () => {
    stubRequest(async () => ({ ok: true }));
    const snapshot = customFrame({
      overlay: true,
      bounds: { row: 2, col: 4, width: 20, height: 2 },
    });
    render(float(snapshot));

    const surface = document.querySelector('[data-tui-surface="overlay"]') as HTMLElement;
    expect(surface).toBeTruthy();
    expect(surface.style.top).toBe("32px");
    expect(surface.style.left).toBe("32px");
    expect(surface.style.width).toBe("160px");
    expect(surface.style.height).toBe("32px");
    // The old implementation dimmed the transcript and swallowed its clicks.
    expect(document.querySelector(".bg-black\\/40")).toBeNull();
    expect(screen.getByLabelText("Extension dialog")).toBeTruthy();
  });

  it("renders a 32-row bottom sheet at 60 rows without collapsing it", () => {
    stubRequest(async () => ({ ok: true }));
    const lines = Array.from({ length: 32 }, (_, index) => `question ${index}`);
    const snapshot = customFrame({
      overlay: true,
      bounds: { row: 28, col: 0, width: 148, height: 32 },
      custom: { seq: 1, width: 148, height: 32, lines, cursor: null },
    });
    render(dock(snapshot, { rows: 60, cols: 148 }));

    expect(document.querySelectorAll("[data-ansi-line]")).toHaveLength(32);
    const surface = document.querySelector('[data-tui-surface="dock"]') as HTMLElement;
    expect(surface.style.maxHeight).toBe(`${60 * CELL.height}px`);
    // A docked overlay is not the extension-editor panel: no caption row.
    expect(screen.queryByText("Extension UI")).toBeNull();
  });

  it("caps a frame taller than the viewport and keeps it scrollable", () => {
    stubRequest(async () => ({ ok: true }));
    const lines = Array.from({ length: 30 }, (_, index) => `row ${index}`);
    const snapshot = customFrame({
      custom: { seq: 1, width: 40, height: 30, lines, cursor: null },
    });
    render(dock(snapshot, { rows: 12, cols: 40 }));

    const surface = document.querySelector('[data-tui-surface="dock"]') as HTMLElement;
    expect(surface.style.maxHeight).toBe(`${12 * CELL.height}px`);
    const scroller = surface.querySelector(".overflow-y-auto");
    expect(scroller).toBeTruthy();
  });

  it("does not send Meta chords", () => {
    const request = stubRequest(async () => ({ ok: true }));
    render(dock(customFrame()));
    fireEvent.keyDown(screen.getByLabelText("Extension input"), { key: "k", metaKey: true });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ method: "tui.input" }));
  });

  it("frames a non-overlay panel with chrome that says it owns the keyboard", () => {
    // While the panel is up it *is* the editor: the composer is gone and the
    // keys go to the extension. The caption says that in words.
    stubRequest(async () => ({ ok: true }));
    render(dock(customFrame()));
    expect(screen.getByText("Extension UI")).toBeInTheDocument();
    expect(screen.getByText(/keys are forwarded to the extension/)).toBeInTheDocument();
  });

  it("paints the extension's selected element with the app's selection style", () => {
    // Pi marks the selected element with a background fill; the surface hands
    // that to the app's selection treatment (plan step 2).
    stubRequest(async () => ({ ok: true }));
    const snapshot = customFrame({
      custom: {
        seq: 1,
        width: 30,
        height: 1,
        lines: ["\x1b[48;2;58;58;74m Scope \x1b[49m"],
        cursor: null,
      },
    });
    render(dock(snapshot));
    const marked = document.querySelector("[data-ansi-line] span");
    expect(marked?.className).toContain("bg-selected");
  });
});

describe("TuiSlotFrame", () => {
  it("renders a read-only frame", () => {
    render(
      <TuiSlotFrame frame={{ seq: 1, width: 10, height: 1, lines: ["footer"], cursor: null }} />,
    );
    expect(screen.getByText("footer")).toBeInTheDocument();
    expect(document.querySelector("[data-tui-slot]")).toBeTruthy();
  });
});
