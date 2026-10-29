import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import { SessionView } from "../../src/renderer/src/views/SessionView";
import { emptyGitSnapshot } from "../../src/shared/git";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { documentsViewFixture, installBridge } from "./fixtures";

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

describe("the docked panel rail (2026-10-29 plan)", () => {
  it("has no Panel button in the session header", () => {
    // The old button was gated on `officeDocuments.available`, so with no Office
    // bridge it vanished — the "sometimes I see it" report. It is gone entirely.
    render(<SessionView />);
    expect(screen.queryByRole("button", { name: /^panel/i })).not.toBeInTheDocument();
    // The header's other controls are untouched.
    expect(screen.getByRole("button", { name: "Change model" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View mode" })).toBeInTheDocument();
  });

  it("shows the strip with no Office bridge at all", () => {
    useAppStore.setState({ officeDocuments: null });
    render(<SessionView />);
    expect(screen.getByTestId("right-rail")).toBeInTheDocument();
    expect(screen.getByTestId("rail-strip")).toBeInTheDocument();
    expect(screen.getByTestId("rail-menu-source-control")).toBeInTheDocument();
    expect(screen.getByTestId("rail-menu-checkpoints")).toBeInTheDocument();
    // No Office bridge ⇒ no Documents entry, which is the standing D-A10 rule.
    expect(screen.queryByTestId("rail-menu-documents")).not.toBeInTheDocument();
  });

  it("adds the Documents entry once the bridge is available", () => {
    useAppStore.setState({
      officeDocuments: documentsViewFixture({ available: true, status: "ok", panes: [] }),
    });
    render(<SessionView />);
    expect(screen.getByTestId("rail-menu-documents")).toBeInTheDocument();
  });

  it("counts the changed files on the Source Control entry", () => {
    const snapshot = {
      ...emptyGitSnapshot("C:/work/app"),
      available: true,
      changed: [
        {
          path: "a.ts",
          origPath: null,
          status: "modified" as const,
          staged: false,
          unstaged: true,
        },
      ],
      staged: [
        {
          path: "b.ts",
          origPath: null,
          status: "modified" as const,
          staged: true,
          unstaged: false,
        },
      ],
    };
    useAppStore.setState({ git: { "C:/work/app": snapshot } });
    render(<SessionView />);
    expect(screen.getByTestId("rail-menu-count-source-control")).toHaveTextContent("2");
  });

  it("watches git without the panel being opened", async () => {
    // The badge lives on the always-visible strip, so the watch follows the tab.
    const handles = installBridge();
    useAppStore.setState({
      prefs: { ...DEFAULT_PREFS, rail: { ...DEFAULT_PREFS.rail, open: false } },
      // These outlive a test: a leftover watch target or snapshot would make the
      // effect short-circuit and hide the behaviour under test.
      gitWatched: null,
      git: {},
    });
    render(<SessionView />);
    await waitFor(() =>
      expect(
        handles.gitCalls.some(
          (call) =>
            call.kind === "watch" && call.projectPath === "C:/work/app" && call.payload === true,
        ),
      ).toBe(true),
    );
  });

  it("seeds the checkpoint badge without the panel being opened", async () => {
    const handles = installBridge();
    useAppStore.setState({
      prefs: { ...DEFAULT_PREFS, rail: { ...DEFAULT_PREFS.rail, open: false } },
      checkpoints: {},
      checkpointsUndoRef: {},
    });
    render(<SessionView />);
    await waitFor(() =>
      expect(handles.checkpointCalls.some((call) => call.kind === "get")).toBe(true),
    );
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

describe("the rail scope line", () => {
  /** Opens the rail on a menu so its body (and scope line) is mounted. */
  function openRail(menu: "source-control" | "checkpoints" | "documents"): void {
    useAppStore.setState({
      prefs: {
        ...useAppStore.getState().prefs,
        rail: { ...useAppStore.getState().prefs.rail, open: true, activeMenu: menu },
      },
    });
  }

  it("names the active session's folder under Source Control", () => {
    openRail("source-control");
    render(<SessionView />);
    const path = screen.getByTestId("rail-scope-path");
    expect(path).toHaveTextContent("app");
    expect(path).toHaveAttribute("title", "C:/work/app");
  });

  it("names it under Checkpoints too, and follows a menu switch", () => {
    openRail("source-control");
    render(<SessionView />);
    expect(screen.getByTestId("rail-scope-path")).toHaveTextContent("app");

    // Checkpoints is scoped to the same folder; the line must not disappear.
    act(() => {
      useAppStore.getState().toggleRailMenu("checkpoints");
    });
    expect(screen.getByTestId("rail-scope-path")).toHaveTextContent("app");
    expect(screen.getByTestId("rail-scope-path")).toHaveAttribute("title", "C:/work/app");
  });

  it("follows the active tab's cwd", () => {
    useAppStore.setState({
      tabs: [
        ...useAppStore.getState().tabs,
        {
          id: "tab-2",
          kind: "session",
          cwd: "C:/work/other-project",
          title: "Other",
          sessionFile: null,
          status: "idle",
          createdAt: 2,
          lastActiveAt: 2,
          model: "anthropic/claude",
        },
      ],
    });
    openRail("source-control");
    render(<SessionView />);
    act(() => {
      useAppStore.getState().activateTab("tab-2");
    });
    expect(screen.getByTestId("rail-scope-path")).toHaveTextContent("other-project");
  });

  it("reaches activateProject for a remembered project", async () => {
    const activateProject = vi.fn(async () => {});
    useAppStore.setState({
      projects: [{ path: "C:/work/app", name: "app", addedAt: 1, lastOpenedAt: 1 }] as never,
      activateProject,
    });
    openRail("source-control");
    render(<SessionView />);

    await userEvent.click(screen.getByRole("button", { name: "Go to project" }));
    expect(activateProject).toHaveBeenCalledWith("C:/work/app");
  });

  it("opens the folder as a project when it is not remembered", async () => {
    const openProject = vi.fn(async () => {});
    useAppStore.setState({ projects: [], openProject });
    openRail("source-control");
    render(<SessionView />);

    await userEvent.click(screen.getByRole("button", { name: "Go to project" }));
    // A session's cwd need not be a saved project; opening it is the one useful
    // thing the button can do there.
    expect(openProject).toHaveBeenCalledWith("C:/work/app");
  });
});

describe("# document completion follows the host session", () => {
  const PANE = {
    host: "excel" as const,
    hostLabel: "Excel",
    paneId: "pane-1",
    clientName: "Excel",
    documentId: "url_sha256:aaaa1111",
    documentName: "Book1.xlsx",
    targetId: "url_sha256:aaaa1111",
    focused: true,
    visible: true,
    windows: 1,
    ops: [],
    catalogVersion: null,
    protocolVersion: null,
    opsIgnoredCount: 0,
    connectedAt: null,
    lastSeen: null,
    model: null,
    provider: null,
    mention: "Book1.xlsx",
  };

  function seedHost(isHostTab: boolean): void {
    useAppStore.setState({
      tabs: [
        { ...useAppStore.getState().tabs[0]!, id: "tab-1", kind: isHostTab ? "office" : "session" },
        ...(isHostTab
          ? []
          : [{ ...useAppStore.getState().tabs[0]!, id: "tab-office", kind: "office" as const }]),
      ],
      activeTabId: "tab-1",
      officeDocuments: documentsViewFixture({
        available: true,
        status: "ok",
        panes: [PANE],
      }),
    });
  }

  it("lists the attached documents in the host session", async () => {
    seedHost(true);
    render(<SessionView />);

    const prompt = screen.getByLabelText("Prompt");
    await userEvent.type(prompt, "#");

    // The completion item's label carries the `#` the user typed.
    expect(await screen.findByText("#Book1.xlsx")).toBeInTheDocument();
    expect(screen.getByTestId("completion-overlay")).toBeInTheDocument();
  });

  it("lists nothing in a sibling session of the same project", async () => {
    seedHost(false);
    render(<SessionView />);

    const prompt = screen.getByLabelText("Prompt");
    await userEvent.type(prompt, "#");

    // The `office_*` call would land on the other tab, so the menu offers
    // nothing rather than a document this session cannot serve.
    await waitFor(() => expect(screen.queryByTestId("completion-overlay")).not.toBeInTheDocument());
    expect(screen.queryByText("#Book1.xlsx")).not.toBeInTheDocument();
  });
});
