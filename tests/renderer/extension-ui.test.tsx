import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { muteRuleFor } from "../../src/shared/notifications";
import type { ExtensionDialogRequest } from "../../src/shared/extension-ui";
import { ExtensionDialogDock } from "../../src/renderer/src/extension-ui/ExtensionDialog";
import { NotificationCenter } from "../../src/renderer/src/extension-ui/NotificationCenter";
import { MuteNotificationDialog } from "../../src/renderer/src/extension-ui/MuteNotificationDialog";
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
    extensionNotifications: [],
    muteTarget: null,
    notificationCooldowns: {},
  });
}

beforeEach(() => {
  resetStore();
});

describe("ExtensionDialog", () => {
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

  function renderDialog(overrides: Partial<ExtensionDialogRequest>) {
    return render(<ExtensionDialogDock dialog={dialogFixture(overrides)} maxHeight={480} />);
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
    expect(dialog.querySelector(".overflow-y-auto")).toBeTruthy();
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
});

describe("StatusBar and notification centre", () => {
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

  it("opens the notification history and clears it", async () => {
    useAppStore.setState({
      extensionNotifications: [
        { id: "n1", message: "Installed workflow", type: "info", tabId: TAB, at: 1 },
      ],
    });
    render(<NotificationCenter />);
    await userEvent.click(screen.getByRole("button", { name: /extension notifications/i }));
    expect(screen.getByText("Installed workflow")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(useAppStore.getState().extensionNotifications).toHaveLength(0);
  });

  it("marks a muted row, opens its settings and unmutes it", async () => {
    const entry = {
      id: "n-muted",
      message: "Installed workflow",
      type: "warning" as const,
      tabId: TAB,
      at: 1,
    };
    useAppStore.getState().muteNotification(entry, "exact");
    useAppStore.setState({ extensionNotifications: [entry], muteTarget: null });
    render(<NotificationCenter />);
    await userEvent.click(screen.getByRole("button", { name: /extension notifications/i }));
    expect(screen.getByTestId("notification-muted")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /notification settings for installed workflow/i }),
    );
    expect(useAppStore.getState().muteTarget).toEqual(entry);

    await userEvent.click(screen.getByRole("button", { name: /unmute notification/i }));
    expect(useAppStore.getState().prefs.notifications.muted).toHaveLength(0);
    expect(screen.queryByTestId("notification-muted")).toBeNull();
  });
});

describe("MuteNotificationDialog", () => {
  const target = {
    id: "n-mute",
    message:
      "Workflow plan: thinking xhigh → high (opencode-go/deepseek-v4.1-flash does not support xhigh).",
    type: "warning" as const,
    tabId: TAB,
    at: 1,
  };

  it("defaults to the template rule and saves it", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ muteTarget: target });
    render(<MuteNotificationDialog />);
    expect(screen.getByRole("dialog", { name: "Notification settings" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mute" }));
    expect(useAppStore.getState().prefs.notifications.muted[0]).toMatchObject({
      scope: "template",
      type: "warning",
    });
    expect(useAppStore.getState().muteTarget).toBeNull();
  });

  it("can save the exact text", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ muteTarget: target });
    render(<MuteNotificationDialog />);
    await user.click(screen.getByRole("radio", { name: /just this notification/i }));
    await user.click(screen.getByRole("button", { name: "Mute" }));
    expect(useAppStore.getState().prefs.notifications.muted[0]?.scope).toBe("exact");
  });

  it("can save the whole type", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ muteTarget: target });
    render(<MuteNotificationDialog />);
    await user.click(screen.getByRole("radio", { name: /all warning notifications/i }));
    await user.click(screen.getByRole("button", { name: "Mute" }));
    expect(useAppStore.getState().prefs.notifications.muted[0]).toMatchObject({
      scope: "type",
      value: "warning",
    });
  });

  it("shows muted state and unmutes", async () => {
    const user = userEvent.setup();
    useAppStore.getState().muteNotification(target, "exact");
    useAppStore.setState({ muteTarget: target });
    render(<MuteNotificationDialog />);
    expect(screen.getByText("muted")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unmute" }));
    expect(useAppStore.getState().prefs.notifications.muted).toHaveLength(0);
  });
});

describe("Transcript extension notices", () => {
  it("hides a muted notify row and restores it on unmute", () => {
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
      prefs: { ...DEFAULT_PREFS, notifications: { muted: [rule] } },
    });
    const view = render(<Transcript items={items} />);
    expect(screen.queryByText("noisy warning")).toBeNull();

    useAppStore.setState({ prefs: { ...DEFAULT_PREFS, notifications: { muted: [] } } });
    view.rerender(<Transcript items={items} />);
    expect(screen.getByText("noisy warning")).toBeInTheDocument();
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
