import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { DEFAULT_NOTIFICATION_PREFS, muteRuleFor } from "../../src/shared/notifications";
import type { KeybindingsSnapshot } from "../../src/shared/keybindings";
import { CONTROL_TAB_ID } from "../../src/shared/session-ipc";
import type { ExtensionDialogRequest } from "../../src/shared/extension-ui";
import { ExtensionDialogDock } from "../../src/renderer/src/extension-ui/ExtensionDialog";
import { WidgetStrip } from "../../src/renderer/src/extension-ui/WidgetStrip";
import { WorkingRow } from "../../src/renderer/src/extension-ui/WorkingRow";
import { StatusBar } from "../../src/renderer/src/layout/StatusBar";
import { ToolCard, Transcript } from "../../src/renderer/src/session/Transcript";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { installBridge } from "./fixtures";

/**
 * The extension-UI renderer surface (plan step 16): dialogs, widgets, working
 * row, status entries and the notification history.
 */

const TAB = "tab-1";

/** The shape of the workflow read/write gate's select title (hard newlines). */
const MULTILINE_TITLE =
  "Read policy: allow 2 reads?\nOutside: C:/repo\n  • read → ../secret/a.txt\n  • read → ../secret/b.txt";

function stubRequest(
  impl: (method: string, params?: unknown) => Promise<unknown> = async () => ({}),
) {
  const request = vi.fn((input: { method: string; params?: unknown }) =>
    impl(input.method, input.params),
  );
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

function resetStore() {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    info: null,
    hint: null,
    tabs: [
      {
        id: TAB,
        kind: "session",
        cwd: "C:/work/app",
        title: "app",
        sessionFile: null,
        status: "running",
        createdAt: 1,
        lastActiveAt: 1,
        model: null,
      },
    ],
    activeTabId: TAB,
    transcripts: {},
    extensionUi: {},
    extensionDialogs: [],
    notifications: [],
    muteTarget: null,
    notificationCooldowns: {},
    // Most dialog tests should not also issue keybindings.get; the one test
    // that exercises the load resets this to false explicitly.
    keybindings: null,
    keybindingsLoaded: true,
  });
}

beforeEach(() => {
  resetStore();
});

describe("ExtensionDialog", () => {
  function keybindings(effective: Record<string, string[]>): KeybindingsSnapshot {
    return {
      path: "C:/state/keybindings.json",
      user: {},
      exists: true,
      effective,
      definitions: [],
      unknownIds: [],
      issues: [],
      conflicts: [],
    };
  }

  function dialogFixture(overrides: Partial<ExtensionDialogRequest>): ExtensionDialogRequest {
    return {
      id: "ui-1",
      method: "select",
      title: "Pick a target",
      options: [],
      message: "",
      placeholder: null,
      prefill: null,
      timeout: null,
      tabId: TAB,
      at: Date.now(),
      ...overrides,
    };
  }

  function renderDialog(overrides: Partial<ExtensionDialogRequest>, active = true) {
    return render(
      <ExtensionDialogDock dialog={dialogFixture(overrides)} maxHeight={480} active={active} />,
    );
  }

  it("renders a select and answers with the chosen option", async () => {
    const request = stubRequest();
    renderDialog({ id: "ui-1", options: ["Sheet1", "Sheet2"] });
    await userEvent.click(screen.getByRole("option", { name: "Sheet2" }));
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "oi.respond",
      params: { id: "ui-1", value: "Sheet2" },
    });
  });

  it("renders inline, with no modal portal or dim backdrop", () => {
    renderDialog({ title: "Pick a target", options: ["Sheet1"] });
    expect(screen.getByRole("dialog", { name: "Pick a target" })).toBeInTheDocument();
    expect(document.querySelector(".bg-black\\/55")).toBeNull();
    expect(document.querySelector("[data-radix-portal]")).toBeNull();
  });

  it("marks the selected option and moves it with the arrow keys", async () => {
    // Pi's select list marks the selected row and moves it with the arrow
    // keys, so the answer is visible before it is given (plan step 4).
    const request = stubRequest();
    renderDialog({ id: "ui-3", options: ["Sheet1", "Sheet2", "Sheet3"] });

    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
    // The marker is what says "this one" — the same marker Pi's list uses.
    expect(options[0]?.textContent).toContain("→");
    expect(options[1]?.textContent).not.toContain("→");

    await userEvent.keyboard("{ArrowDown}");
    const moved = screen.getAllByRole("option");
    expect(moved[1]).toHaveAttribute("aria-selected", "true");
    expect(moved[0]).toHaveAttribute("aria-selected", "false");

    await userEvent.keyboard("{Enter}");
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "oi.respond",
      params: { id: "ui-3", value: "Sheet2" },
    });
  });

  it("keeps every line of a select title", () => {
    renderDialog({ id: "ui-title", title: MULTILINE_TITLE, options: ["Allow", "Deny"] });

    // The select title is extension-owned text, like a confirm message and an
    // option label: every hard newline (and the bullet indentation) must survive.
    const heading = screen.getByRole("heading", { level: 2 });
    const text = heading.querySelector(".whitespace-pre-wrap.break-words");
    expect(text).not.toBeNull();
    expect(text?.textContent).toBe(MULTILINE_TITLE);

    const scroller = screen.getByTestId("extension-dialog-title");
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller).toHaveStyle({ maxHeight: "216px" });
  });

  it("answers the highlighted option when focus is outside the dialog", async () => {
    // The reported case: the permission prompt is on screen, but focus stayed on
    // the page (a grid pane, a clicked title, a background window). Terminal Pi's
    // selector still owns Up/Down and Enter there; the desktop must too.
    const request = stubRequest();
    renderDialog({
      id: "ui-body",
      options: ["Allow once (this turn)", "Always allow this folder", "Deny"],
    });
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    fireEvent.keyDown(document.body, { key: "Enter" });

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: TAB,
        method: "oi.respond",
        params: { id: "ui-body", value: "Always allow this folder" },
      }),
    );
  });

  it("cancels from the page when focus is outside the dialog", async () => {
    const request = stubRequest();
    renderDialog({ id: "ui-esc", options: ["Allow", "Deny"] });
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: TAB,
        method: "oi.respond",
        params: { id: "ui-esc", cancelled: true },
      }),
    );
  });

  it("cancels a select with Ctrl+C from the page", async () => {
    const request = stubRequest();
    renderDialog({ id: "ui-ctrlc", options: ["Allow", "Deny"] });
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(document.body, { key: "c", ctrlKey: true });

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: TAB,
        method: "oi.respond",
        params: { id: "ui-ctrlc", cancelled: true },
      }),
    );
  });

  it("keeps Ctrl+C as copy when text is selected", () => {
    const request = stubRequest();
    renderDialog({ id: "ui-copy", options: ["Allow", "Deny"] });
    (document.activeElement as HTMLElement | null)?.blur();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(screen.getByTestId("extension-dialog-title"));
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.keyDown(document.body, { key: "c", ctrlKey: true });
    expect(request).not.toHaveBeenCalled();
    selection?.removeAllRanges();
  });

  it("does not take keys when its pane is not active", () => {
    const request = stubRequest();
    renderDialog({ id: "ui-inactive", options: ["Allow", "Deny"] }, false);
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels an editor from the page with Escape only", async () => {
    const request = stubRequest();
    renderDialog({ id: "ui-editor-esc", method: "editor", title: "Notes" });
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: TAB,
        method: "oi.respond",
        params: { id: "ui-editor-esc", cancelled: true },
      }),
    );
  });

  it("settles a request once when Escape is pressed twice", async () => {
    const request = stubRequest();
    renderDialog({ id: "ui-once", options: ["Allow", "Deny"] });
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "oi.respond",
      params: { id: "ui-once", cancelled: true },
    });
  });

  it("moves the select with j/k from the page", async () => {
    const request = stubRequest();
    renderDialog({ id: "ui-jk", options: ["a", "b", "c"] });
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(document.body, { key: "j" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(document.body, { key: "j" });
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(document.body, { key: "k" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(document.body, { key: "Enter" });
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: TAB,
        method: "oi.respond",
        params: { id: "ui-jk", value: "b" },
      }),
    );
  });

  it("clamps the select at the first and last option", () => {
    renderDialog({ options: ["a", "b", "c"] });
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(document.body, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");

    for (let index = 0; index < 4; index += 1) {
      fireEvent.keyDown(document.body, { key: "ArrowDown" });
    }
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
  });

  it("honours a tui.select.down remap", () => {
    useAppStore.setState({
      keybindings: keybindings({ "tui.select.down": ["ctrl+shift+d"] }),
      keybindingsLoaded: true,
    });
    renderDialog({ options: ["a", "b"] });
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(document.body, { key: "D", ctrlKey: true, shiftKey: true });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
  });

  it("shows the effective select keys in the hint", () => {
    useAppStore.setState({
      keybindings: keybindings({ "tui.select.down": ["ctrl+shift+d"] }),
      keybindingsLoaded: true,
    });
    renderDialog({ options: ["a", "b"] });

    const hint = screen.getByTestId("extension-dialog-select-hint");
    expect(hint).toHaveTextContent("ctrl+shift+d");
    expect(hint).not.toHaveTextContent("↓");
    expect(hint).toHaveTextContent(/navigate/);
  });

  it("loads the profile keybindings once when the snapshot is missing", async () => {
    useAppStore.setState({ keybindings: null, keybindingsLoaded: false });
    const request = stubRequest();
    renderDialog({ id: "ui-keys", options: ["a"] });

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: CONTROL_TAB_ID,
        method: "keybindings.get",
      }),
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("moves confirm focus with Up/Down and keeps Enter native", async () => {
    const request = stubRequest();
    renderDialog({
      id: "ui-confirm-arrows",
      method: "confirm",
      title: "Delete?",
      message: "This cannot be undone.",
    });
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: TAB,
        method: "oi.respond",
        params: { id: "ui-confirm-arrows", cancelled: true },
      }),
    );
  });

  it("returns confirm focus to Confirm with ArrowUp", async () => {
    const request = stubRequest();
    renderDialog({
      id: "ui-confirm-up",
      method: "confirm",
      title: "Delete?",
      message: "This cannot be undone.",
    });
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    fireEvent.keyDown(document.body, { key: "ArrowUp" });
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();

    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: TAB,
        method: "oi.respond",
        params: { id: "ui-confirm-up", confirmed: true },
      }),
    );
  });

  it("cancels a confirm from the page", async () => {
    const request = stubRequest();
    renderDialog({ id: "ui-confirm-esc", method: "confirm", title: "Delete?", message: "Sure?" });
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: TAB,
        method: "oi.respond",
        params: { id: "ui-confirm-esc", cancelled: true },
      }),
    );
  });

  it("keeps Ctrl+C out of the editor's cancel path", () => {
    const request = stubRequest();
    renderDialog({ id: "ui-editor-copy", method: "editor", title: "Notes", prefill: "abc" });

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Notes" }), {
      key: "c",
      ctrlKey: true,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps every line of a confirm message", () => {
    renderDialog({
      id: "ui-lines",
      method: "confirm",
      title: "Delete?",
      message: "line one\nline two",
    });

    const message = screen.getByText(/line one\s+line two/);
    expect(message.className).toContain("whitespace-pre-wrap");
    expect(message.className).toContain("break-words");
    expect(message.textContent).toBe("line one\nline two");
  });

  it("keeps every line of a select option", () => {
    renderDialog({ id: "ui-lines", options: ["First\nline", "Second"] });

    const option = screen.getByRole("option", { name: /First\s+line/ });
    const label = option.querySelector(".whitespace-pre-wrap");
    expect(label).not.toBeNull();
    expect(label?.textContent).toBe("First\nline");
  });

  it("cancels a confirm on Escape", async () => {
    const request = stubRequest();
    renderDialog({
      id: "ui-2",
      method: "confirm",
      title: "Delete?",
      message: "This cannot be undone.",
    });
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "oi.respond",
      params: { id: "ui-2", cancelled: true },
    });
  });

  it("submits an input value", async () => {
    const request = stubRequest();
    renderDialog({ id: "ui-3", method: "input", title: "Name", placeholder: "e.g. report" });
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "report");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "oi.respond",
      params: { id: "ui-3", value: "report" },
    });
  });

  it("submits the multi-line editor on Enter and keeps Shift+Enter for a newline", () => {
    const request = stubRequest();
    renderDialog({ id: "ui-editor", method: "editor", title: "Notes", prefill: "first" });
    const editor = screen.getByRole("textbox", { name: "Notes" });

    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ method: "oi.respond" }));

    fireEvent.change(editor, { target: { value: "first\nsecond" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "oi.respond",
      params: { id: "ui-editor", value: "first\nsecond" },
    });
  });

  it("keeps a tall dialog scrollable inside the session column", () => {
    renderDialog({ options: Array.from({ length: 40 }, (_, index) => `option ${index}`) });
    const dialog = screen.getByRole("dialog", { name: "Pick a target" });
    expect(dialog).toHaveStyle({ maxHeight: "480px" });
    // The options have their own scroller; the title now has one too, so this
    // must target the body rather than the first `.overflow-y-auto`.
    const body = screen.getByTestId("extension-dialog-body");
    expect(body.className).toContain("overflow-y-auto");
  });

  it("enforces the extension's timeout in the store, even off-screen", () => {
    vi.useFakeTimers();
    try {
      const request = stubRequest();
      act(() => {
        useAppStore.getState().handleExtensionUiEvent(TAB, {
          event: "oi.request",
          payload: {
            id: "ui-4",
            method: "select",
            params: { title: "Pick", options: ["a", "b"], timeout: 1000 },
          },
        });
      });
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      expect(request).toHaveBeenCalledWith({
        tabId: TAB,
        method: "oi.respond",
        params: { id: "ui-4", cancelled: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WidgetStrip", () => {
  it("renders string widgets for its placement only", () => {
    useAppStore.setState({
      extensionUi: {
        [TAB]: {
          statuses: {},
          widgets: [
            { key: "above", lines: ["above line"], placement: "aboveEditor" },
            { key: "below", lines: ["below line"], placement: "belowEditor" },
          ],
          working: { message: null, visible: null, frames: null, intervalMs: null },
          hiddenThinkingLabel: null,
          title: null,
          toolsExpanded: null,
          autocompleteProviders: 0,
          editor: null,
        },
      },
    });
    const { container } = render(
      <>
        <WidgetStrip tabId={TAB} placement="aboveEditor" />
        <WidgetStrip tabId={TAB} placement="belowEditor" />
      </>,
    );
    expect(container).toHaveTextContent("above line");
    expect(container).toHaveTextContent("below line");
    expect(screen.getByTestId("extension-widgets-aboveEditor")).not.toHaveTextContent("below line");
  });

  it("renders nothing without widgets", () => {
    const { container } = render(<WidgetStrip tabId={TAB} placement="aboveEditor" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("WorkingRow", () => {
  it("shows the custom message and hides on demand", () => {
    const { rerender } = render(
      <WorkingRow
        working={{ message: "Compacting", visible: null, frames: null, intervalMs: null }}
      />,
    );
    expect(screen.getByText("Compacting")).toBeInTheDocument();

    rerender(
      <WorkingRow working={{ message: null, visible: false, frames: null, intervalMs: null }} />,
    );
    expect(screen.queryByTestId("extension-working-row")).toBeNull();
  });

  it("keeps every line of a working message", () => {
    render(
      <WorkingRow
        working={{ message: "line one\nline two", visible: null, frames: null, intervalMs: null }}
      />,
    );

    const message = screen.getByText(/line one\s+line two/);
    expect(message.className).toContain("whitespace-pre-wrap");
    expect(message.textContent).toBe("line one\nline two");
  });

  it("uses the default label and hides on empty frames", () => {
    const { rerender } = render(
      <WorkingRow working={{ message: null, visible: null, frames: null, intervalMs: null }} />,
    );
    expect(screen.getByText("Working…")).toBeInTheDocument();

    rerender(
      <WorkingRow working={{ message: null, visible: null, frames: [], intervalMs: null }} />,
    );
    expect(screen.queryByTestId("extension-working-row")).toBeNull();
  });

  it("shows elapsed time and the Esc hint for a running session (plan step 8)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
    render(
      <WorkingRow
        working={{ message: null, visible: null, frames: null, intervalMs: null }}
        startedAt={Date.now() - 65_000}
        showCancelHint
      />,
    );
    expect(screen.getByText("1:05")).toBeInTheDocument();
    expect(screen.getByText("Esc to cancel")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByText("1:07")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("uses the caller's action hint for a review", () => {
    render(
      <WorkingRow
        working={{ message: "🔍 Reviewing plan…", visible: null, frames: null, intervalMs: null }}
        showCancelHint
        cancelHint="ESC to pause · /review pause, /review abort"
      />,
    );
    expect(screen.getByText("ESC to pause · /review pause, /review abort")).toBeInTheDocument();
  });
});

describe("StatusBar", () => {
  it("carries only app-level facts, with the full path in the title", () => {
    // Extension statuses moved to the composer footer (2026-10-19 UI rework),
    // because they describe a session rather than the app. The bar keeps the
    // build, the profile and the runtime — each with its exact value in `title`
    // so the visible chrome can stay one line.
    useAppStore.setState({
      info: {
        ...(useAppStore.getState().info ?? ({} as never)),
        version: "0.1.0",
        profileDir: "C:\\Users\\test\\.pi\\agent",
        runtimeSource: "bundled",
        runtimeNodeVersion: "22.11.0",
        runtimeProblems: [],
      },
      hint: null,
    });
    render(<StatusBar />);

    expect(screen.getByTestId("status-profile")).toHaveTextContent("profile: agent");
    expect(screen.getByTestId("status-profile")).toHaveAttribute(
      "title",
      "The profile shared with terminal Pi: C:\\Users\\test\\.pi\\agent",
    );
    expect(screen.getByTestId("status-runtime")).toHaveTextContent(
      "runtime: bundled · node 22.11.0",
    );
    expect(screen.getByTestId("status-version")).toHaveTextContent("v0.1.0");
  });

  it("does not render extension statuses any more", () => {
    // The regression this pins: the bar must not quietly regain a second home
    // for session-scoped status text.
    useAppStore.setState({
      extensionUi: {
        [TAB]: {
          statuses: { workflow: "▶ build 3/8" },
          widgets: [],
          working: { message: null, visible: null, frames: null, intervalMs: null },
          hiddenThinkingLabel: null,
          title: null,
          toolsExpanded: null,
          autocompleteProviders: 0,
          editor: null,
        },
      },
    });
    render(<StatusBar />);
    expect(screen.queryByTestId("extension-status-workflow")).toBeNull();
    expect(screen.queryByText(/build 3\/8/)).toBeNull();
  });

  it("marks the runtime chip when the bundled runtime reported problems", () => {
    useAppStore.setState({
      info: {
        ...(useAppStore.getState().info ?? ({} as never)),
        profileDir: "C:\\p",
        runtimeSource: "system",
        runtimeNodeVersion: "20.0.0",
        runtimeProblems: ["missing node"],
      },
    });
    render(<StatusBar />);
    expect(screen.getByTestId("status-runtime")).toHaveClass("text-warn");
    expect(screen.getByTestId("status-runtime")).toHaveAttribute(
      "title",
      expect.stringContaining("1 problem(s)"),
    );
  });
});

describe("Transcript extension notices", () => {
  it("renders an info notify row with default prefs (terminal parity)", () => {
    const items = [
      {
        kind: "notice" as const,
        id: "notice-info",
        notice: {
          id: "notice-info",
          severity: "info" as const,
          event: "oi.notify",
          text: "Server logs ready (local)",
        },
      },
    ];
    useAppStore.setState({
      prefs: { ...DEFAULT_PREFS, notifications: { ...DEFAULT_NOTIFICATION_PREFS } },
    });
    render(<Transcript items={items} />);

    const text = screen.getByTestId("transcript-notice-text");
    expect(text.textContent).toBe("Server logs ready (local)");
    expect(text.className).toContain("whitespace-pre-wrap");
    expect(text.className).toContain("break-words");
    expect(screen.getByText("info")).toBeInTheDocument();
  });

  it("renders a warning row even when its class is off and a mute rule matches", () => {
    const items = [
      {
        kind: "notice" as const,
        id: "notice-1",
        notice: {
          id: "notice-1",
          severity: "warning" as const,
          event: "oi.notify",
          text: "noisy warning",
        },
      },
    ];
    const rule = muteRuleFor({ message: "noisy warning", type: "warning" }, "exact");
    useAppStore.setState({
      prefs: {
        ...DEFAULT_PREFS,
        notifications: {
          ...DEFAULT_NOTIFICATION_PREFS,
          classes: { ...DEFAULT_NOTIFICATION_PREFS.classes, warning: false },
          muted: [rule],
        },
      },
    });
    render(<Transcript items={items} />);

    expect(screen.getByText("noisy warning")).toBeInTheDocument();
    expect(screen.getByTestId("transcript-notice-text").className).toContain("whitespace-pre-wrap");
  });
});

describe("Transcript extension props", () => {
  it("uses the hidden thinking label and expands tool cards", () => {
    render(
      <Transcript
        items={[
          {
            kind: "message",
            id: "m1",
            message: {
              id: "m1",
              role: "assistant",
              blocks: [{ kind: "thinking", text: "secret reasoning" }],
              streaming: false,
            },
          },
          {
            kind: "tool",
            id: "t1",
            tool: {
              toolCallId: "t1",
              toolName: "read",
              args: { path: "src/a.ts" },
              done: true,
              isError: false,
              resultText: "file contents",
              version: 1,
            },
          },
        ]}
        thinkingLabel="Reasoning hidden"
        toolsExpanded
      />,
    );
    expect(screen.getByText("Reasoning hidden")).toBeInTheDocument();
    expect(screen.getByText("file contents")).toBeInTheDocument();
  });

  it("shows a short preview while keeping the full card collapsed", () => {
    render(
      <ToolCard
        tool={{
          toolCallId: "t",
          toolName: "read",
          args: {},
          done: true,
          isError: false,
          resultText: "hidden output",
          version: 1,
        }}
      />,
    );
    expect(screen.getByText("hidden output")).toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });
});
