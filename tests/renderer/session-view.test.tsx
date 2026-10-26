import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import { SessionView } from "../../src/renderer/src/views/SessionView";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The session view's chrome (plan step 6).
 *
 * The header used to pack eight differently-styled controls, including a
 * native `<select>` that matched nothing beside it. The cluster is now one row
 * of equally-weighted buttons, and the view mode is a menu in the app's own
 * vocabulary.
 */

const TAB = "tab-1";

function resetStore(): void {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {}, viewMode: "normal" },
    tabs: [
      {
        id: TAB,
        kind: "session",
        cwd: "C:/work/app",
        title: "Fix the bug",
        sessionFile: null,
        status: "idle",
        createdAt: 1,
        lastActiveAt: 1,
        model: "anthropic/claude",
      },
    ],
    activeTabId: TAB,
    transcripts: {},
    sessionStates: {},
    extensionUi: {},
    tuiSurfaces: {},
    picker: null,
  });
}

beforeEach(() => {
  resetStore();
});

describe("session header", () => {
  it("uses the user-facing lifecycle word for an idle session", () => {
    render(<SessionView />);
    expect(screen.getByTitle("Session status: ready")).toHaveTextContent("ready");
    expect(screen.queryByText("idle")).toBeNull();
  });

  it("shows the view mode as one of the header's buttons, not a native select", () => {
    render(<SessionView />);
    // A native select was the only unstyled control in the header.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button", { name: "View mode" })).toHaveTextContent("Normal");
  });

  it("switches the view mode from the menu", async () => {
    const user = userEvent.setup();
    render(<SessionView />);

    await user.click(screen.getByRole("button", { name: "View mode" }));
    await user.click(await screen.findByRole("menuitem", { name: /Verbose/ }));
    expect(useAppStore.getState().prefs.viewMode).toBe("verbose");
  });

  it("keeps the facts and the actions in one cluster, split by a rule", () => {
    render(<SessionView />);
    // The vertical rule says which way it runs, so assistive tech reads it as
    // a separator between the two groups (plan step 6).
    const rule = document.querySelector('[aria-orientation="vertical"]');
    expect(rule).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change model" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change thinking level" })).toBeInTheDocument();
  });

  it("shows the live model from the session state, not the stale tab record", () => {
    // The tab spawned on one model; the host has since switched (plan step 1).
    useAppStore.setState({
      sessionStates: { [TAB]: { model: { provider: "opencode-go", id: "other-model" } } },
    });
    render(<SessionView />);
    expect(screen.getByRole("button", { name: "Change model" })).toHaveTextContent(
      "opencode-go/other-model",
    );
  });

  it("moves the header when a host state frame reports a different model", () => {
    render(<SessionView />);
    act(() => {
      useAppStore.getState().applySessionState({
        tabId: TAB,
        state: { model: { provider: "openai", id: "gpt-5" } },
      });
    });
    expect(screen.getByRole("button", { name: "Change model" })).toHaveTextContent("openai/gpt-5");
  });
});

describe("model picker per tab", () => {
  it("remounts the picker per tab and never offers a save-as-default switch", () => {
    const second = { ...useAppStore.getState().tabs[0]!, id: "tab-2", title: "Second" };
    useAppStore.setState({
      tabs: [...useAppStore.getState().tabs, second],
      picker: "model",
      modelCatalog: {
        [TAB]: [
          {
            key: "openai/gpt-5",
            id: "gpt-5",
            provider: "openai",
            label: "GPT-5",
            raw: { id: "gpt-5", provider: "openai" },
          },
        ],
      },
    });
    const { rerender } = render(<SessionView />);
    // Keying the dialog by tab remounts it, so transient state cannot carry over.
    useAppStore.setState({ activeTabId: "tab-2" });
    rerender(<SessionView />);
    expect(screen.getByLabelText("Choose a model")).toBeInTheDocument();
    // Every pick now saves as the default, so the switch is gone for good.
    expect(screen.queryByLabelText("Save as default")).toBeNull();
  });
});

describe("composer rows", () => {
  it("puts the shortcut hints and the caret readout on one row", () => {
    render(<SessionView />);
    const row = screen.getByTestId("composer-caret").parentElement;
    expect(row?.textContent).toContain("commands");
    expect(row?.textContent).toContain("Ln 1 · Col 1");
  });
});

describe("idle session wake (2026-10-24 plan)", () => {
  it("focuses the composer when the transcript background is clicked", () => {
    render(<SessionView />);
    const box = screen.getByLabelText("Prompt");
    box.blur();
    expect(box).not.toHaveFocus();

    fireEvent.click(screen.getByText("This session is ready"));

    expect(box).toHaveFocus();
  });

  it("wakes a stopped session when the composer is focused", async () => {
    const handles = installBridge();
    const activate = vi.spyOn(handles.bridge.sessions, "activate");
    useAppStore.setState({
      tabs: [{ ...useAppStore.getState().tabs[0]!, status: "stopped" }],
      activeTabId: TAB,
    });

    render(<SessionView />);
    const box = screen.getByLabelText("Prompt");
    expect(box).toBeEnabled();

    fireEvent.focus(box);
    await waitFor(() => expect(activate).toHaveBeenCalledWith(TAB));
  });

  it("does not auto-wake a crashed session", () => {
    const handles = installBridge();
    const activate = vi.spyOn(handles.bridge.sessions, "activate");
    useAppStore.setState({
      tabs: [{ ...useAppStore.getState().tabs[0]!, status: "crashed" }],
      activeTabId: TAB,
    });

    render(<SessionView />);
    const box = screen.getByLabelText("Prompt");
    expect(box).toBeDisabled();

    fireEvent.focus(box);
    expect(activate).not.toHaveBeenCalled();
  });
});

/** A DOMRect-shaped value for the layout stubs (jsdom has no layout). */
function rect(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * Give the session column and its monospace probe a real box. Every other
 * element keeps jsdom's zero rect, matching the production fallback.
 */
function stubViewportLayout(width = 1200, height = 600, cell = { width: 8, height: 16 }): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this instanceof HTMLElement && this.matches("[data-tui-cell-probe]")) {
      return rect(cell.width, cell.height);
    }
    if (this instanceof HTMLElement && this.matches("[data-tui-viewport]")) {
      return rect(width, height);
    }
    return rect(0, 0);
  });
}

function resizeCalls(request: { mock: { calls: unknown[][] } }): Array<{ params?: unknown }> {
  return request.mock.calls
    .map((call) => call[0] as { method?: string; params?: unknown })
    .filter((input) => input.method === "tui.resize");
}

function surfaceFrame(lines: number) {
  return {
    active: true,
    overlay: false,
    bounds: null,
    focus: "custom" as const,
    custom: {
      seq: 1,
      width: 150,
      height: lines,
      lines: Array.from({ length: lines }, (_, index) => `row ${index}`),
      cursor: null,
    },
    footer: null,
    header: null,
    widgetsAbove: [],
    widgetsBelow: [],
  };
}

describe("TUI viewport grid (2026-10-26 plan, step 1)", () => {
  it("reports the session column, not the surface frame", () => {
    const handles = installBridge();
    const request = vi.spyOn(handles.bridge.sessions, "request");
    stubViewportLayout();

    render(<SessionView />);

    const calls = resizeCalls(request);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({ rows: 37, cols: 150 });
  });

  it("does not re-measure when an extension frame changes height", () => {
    const handles = installBridge();
    const request = vi.spyOn(handles.bridge.sessions, "request");
    stubViewportLayout();
    render(<SessionView />);

    act(() => {
      useAppStore.setState({ tuiSurfaces: { [TAB]: surfaceFrame(32) } });
    });

    // The old implementation reported the 32-line frame back as terminal rows,
    // which is what collapsed the questionnaire.
    expect(resizeCalls(request)).toHaveLength(1);
  });

  it("re-reports the same grid after a status change (a fresh host)", () => {
    const handles = installBridge();
    const request = vi.spyOn(handles.bridge.sessions, "request");
    stubViewportLayout();
    render(<SessionView />);
    expect(resizeCalls(request)).toHaveLength(1);

    act(() => {
      useAppStore.setState({
        tabs: useAppStore
          .getState()
          .tabs.map((tab) => (tab.id === TAB ? { ...tab, status: "running" as const } : tab)),
      });
    });

    const calls = resizeCalls(request);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.params).toEqual({ rows: 37, cols: 150 });
  });

  it("keeps the 80x24 fallback when jsdom has no layout", () => {
    const handles = installBridge();
    const request = vi.spyOn(handles.bridge.sessions, "request");
    render(<SessionView />);

    expect(resizeCalls(request)[0]?.params).toEqual({ rows: 24, cols: 80 });
  });
});

function overlaySurfaceFrame(
  bounds: { row: number; col: number; width: number; height: number },
  lines = 12,
) {
  return {
    ...surfaceFrame(lines),
    overlay: true,
    bounds,
    custom: {
      seq: 1,
      width: bounds.width,
      height: lines,
      lines: Array.from({ length: lines }, (_, index) => `option ${index}`),
      cursor: null,
    },
  };
}

describe("TUI surface presentation (2026-10-26 plan, step 2)", () => {
  it("docks the questionnaire's bottom sheet inside the session column", () => {
    useAppStore.setState({
      tuiSurfaces: {
        [TAB]: overlaySurfaceFrame({ row: 12, col: 0, width: 80, height: 12 }),
      },
    });

    render(<SessionView />);

    const surface = document.querySelector('[data-tui-surface="dock"]');
    expect(surface).toBeTruthy();
    expect(surface?.closest("[data-tui-viewport]")).toBeTruthy();
    // No page-level wrapper and no dim backdrop: the transcript stays usable.
    expect(document.querySelector("[data-tui-overlay]")).toBeNull();
    expect(document.querySelector(".bg-black\\/40")).toBeNull();
    // The dock replaces the composer, exactly as Pi's editor dock does.
    expect(screen.queryByLabelText("Prompt")).toBeNull();
    expect(document.querySelector("[data-tui-viewport]")).toBeTruthy();
  });

  it("floats a non-bottom overlay inside the column and keeps the composer", () => {
    useAppStore.setState({
      tuiSurfaces: {
        [TAB]: overlaySurfaceFrame({ row: 7, col: 20, width: 40, height: 6 }),
      },
    });

    render(<SessionView />);

    const overlay = document.querySelector('[data-tui-surface="overlay"]');
    expect(overlay).toBeTruthy();
    expect(overlay?.closest("[data-tui-viewport]")).toBeTruthy();
    expect(document.querySelector(".bg-black\\/40")).toBeNull();
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
  });

  it("gives the keyboard back to a docked surface when the transcript is clicked", () => {
    useAppStore.setState({
      tuiSurfaces: {
        [TAB]: overlaySurfaceFrame({ row: 12, col: 0, width: 80, height: 12 }),
      },
    });
    render(<SessionView />);
    const surface = document.querySelector('[data-tui-surface="dock"]') as HTMLElement;
    surface.blur();
    expect(surface).not.toHaveFocus();

    fireEvent.click(screen.getByText("This session is ready"));

    expect(surface).toHaveFocus();
    expect(screen.queryByLabelText("Prompt")).toBeNull();
  });

  it("makes the composer inert while a floating overlay owns the keyboard", () => {
    useAppStore.setState({
      tuiSurfaces: {
        [TAB]: overlaySurfaceFrame({ row: 7, col: 20, width: 40, height: 6 }),
      },
    });
    render(<SessionView />);

    const prompt = screen.getByLabelText("Prompt");
    const wrapper = prompt.closest(".contents");
    expect(wrapper).toHaveAttribute("inert");

    const overlay = document.querySelector('[data-tui-surface="overlay"]') as HTMLElement;
    overlay.blur();
    fireEvent.click(screen.getByText("This session is ready"));
    expect(overlay).toHaveFocus();
  });

  it("renders an extension dialog in the composer region, not as a modal", () => {
    useAppStore.setState({
      extensionDialogs: [
        {
          id: "ui-1",
          method: "select",
          title: "Pick a target",
          options: ["Sheet1", "Sheet2"],
          message: "",
          placeholder: null,
          prefill: null,
          timeout: null,
          tabId: TAB,
          at: Date.now(),
        },
      ],
    });

    render(<SessionView />);

    const dialog = screen.getByRole("dialog", { name: "Pick a target" });
    expect(dialog.closest("[data-tui-viewport]")).toBeTruthy();
    expect(document.querySelector(".bg-black\\/55")).toBeNull();
    expect(screen.queryByLabelText("Prompt")).toBeNull();

    // Another tab's dialog is not shown here; the owning tab is activated when
    // it arrives (the store does that on `oi.request`).
    act(() => {
      useAppStore.setState({
        extensionDialogs: [
          {
            id: "ui-2",
            method: "select",
            title: "Elsewhere",
            options: ["a"],
            message: "",
            placeholder: null,
            prefill: null,
            timeout: null,
            tabId: "tab-2",
            at: Date.now(),
          },
        ],
      });
    });
    expect(screen.queryByRole("dialog", { name: "Elsewhere" })).toBeNull();
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
  });

  it("renders TUI header slots full-bleed so cols-wide frames do not clip", () => {
    useAppStore.setState({
      tuiSurfaces: {
        [TAB]: {
          ...surfaceFrame(1),
          header: { seq: 2, width: 80, height: 1, lines: ["HEADER"], cursor: null },
        },
      },
    });

    render(<SessionView />);

    const slot = document.querySelector("[data-tui-slot]");
    expect(slot?.textContent).toContain("HEADER");
    expect(slot?.className).not.toContain("px-3");
  });

  it("renders component widgets above and below the editor dock", () => {
    useAppStore.setState({
      tuiSurfaces: {
        [TAB]: {
          ...surfaceFrame(1),
          widgetsAbove: [{ seq: 3, width: 80, height: 1, lines: ["ABOVE"], cursor: null }],
          widgetsBelow: [{ seq: 4, width: 80, height: 1, lines: ["BELOW"], cursor: null }],
        },
      },
    });

    render(<SessionView />);

    expect(screen.getByText("ABOVE")).toBeInTheDocument();
    expect(screen.getByText("BELOW")).toBeInTheDocument();
    expect(document.querySelector('[data-tui-widgets="aboveEditor"]')).toBeTruthy();
    expect(document.querySelector('[data-tui-widgets="belowEditor"]')).toBeTruthy();
  });
});
