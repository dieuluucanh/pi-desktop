import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TuiSlotFrame, TuiSurface } from "../../src/renderer/src/tui/TuiSurface";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { EMPTY_TUI_SURFACE, type TuiSurfaceSnapshot } from "../../src/shared/tui-surface";
import { installBridge } from "./fixtures";

/**
 * The interactive TUI surface (plan step 17).
 *
 * What matters: a custom frame replaces the composer and takes the keyboard,
 * DOM keys become terminal bytes, a paste is bracketed, the host-issued cursor
 * is drawn, an overlay is positioned from the host's bounds, and an inactive
 * surface renders nothing.
 */

const TAB = "tab-1";

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

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    tuiSurfaces: {},
  });
});

describe("TuiSurface", () => {
  it("renders nothing when inactive", () => {
    const { container } = render(<TuiSurface tabId={TAB} snapshot={EMPTY_TUI_SURFACE} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a custom frame, the cursor, and forwards keys as terminal bytes", () => {
    const request = stubRequest(async () => ({ ok: true }));
    render(<TuiSurface tabId={TAB} snapshot={customFrame()} />);

    expect(screen.getByText("Pick one")).toBeInTheDocument();
    expect(document.querySelector("[data-tui-cursor]")).toBeTruthy();
    expect(document.querySelector('[data-tui-surface="panel"]')).toBeTruthy();

    fireEvent.keyDown(screen.getByLabelText("Extension input"), { key: "ArrowDown" });
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "tui.input",
      params: { data: "\x1b[B" },
    });
  });

  it("frames a paste as a bracketed paste", () => {
    const request = stubRequest(async () => ({ ok: true }));
    render(<TuiSurface tabId={TAB} snapshot={customFrame()} />);
    fireEvent.paste(screen.getByLabelText("Extension input"), {
      clipboardData: { getData: () => "hello world" },
    });
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "tui.input",
      params: { data: "\x1b[200~hello world\x1b[201~" },
    });
  });

  it("reports its measured grid", () => {
    const request = stubRequest(async () => ({ ok: true }));
    render(<TuiSurface tabId={TAB} snapshot={customFrame()} />);
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "tui.resize",
      params: { rows: 24, cols: 80 },
    });
  });

  it("positions an overlay from the host's bounds", () => {
    stubRequest(async () => ({ ok: true }));
    const snapshot = customFrame({
      overlay: true,
      bounds: { row: 2, col: 4, width: 20, height: 2 },
    });
    render(<TuiSurface tabId={TAB} snapshot={snapshot} />);
    expect(document.querySelector("[data-tui-overlay]")).toBeTruthy();
    expect(screen.getByLabelText("Extension dialog")).toBeTruthy();
  });

  it("does not send Meta chords", () => {
    const request = stubRequest(async () => ({ ok: true }));
    render(<TuiSurface tabId={TAB} snapshot={customFrame()} />);
    fireEvent.keyDown(screen.getByLabelText("Extension input"), { key: "k", metaKey: true });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ method: "tui.input" }));
  });

  it("frames the extension surface with chrome that says it owns the keyboard", () => {
    // While the panel is up it *is* the editor: the composer is gone and the
    // keys go to the extension. The caption says that in words and the accent
    // border says it at a glance (plan step 2).
    stubRequest(async () => ({ ok: true }));
    render(<TuiSurface tabId={TAB} snapshot={customFrame()} />);
    const panel = document.querySelector('[data-tui-surface="panel"]');
    expect(panel?.className).toContain("border-accent");
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
    render(<TuiSurface tabId={TAB} snapshot={snapshot} />);
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
