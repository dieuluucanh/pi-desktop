import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { ExtensionDialog } from "../../src/renderer/src/extension-ui/ExtensionDialog";
import { NotificationCenter } from "../../src/renderer/src/extension-ui/NotificationCenter";
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
  });
}

beforeEach(() => {
  resetStore();
});

describe("ExtensionDialog", () => {
  it("renders a select and answers with the chosen option", async () => {
    const request = stubRequest();
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
    render(<ExtensionDialog />);
    await userEvent.click(screen.getByRole("button", { name: "Sheet2" }));
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "oi.respond",
      params: { id: "ui-1", value: "Sheet2" },
    });
  });

  it("cancels a confirm on Escape", async () => {
    const request = stubRequest();
    useAppStore.setState({
      extensionDialogs: [
        {
          id: "ui-2",
          method: "confirm",
          title: "Delete?",
          options: [],
          message: "This cannot be undone.",
          placeholder: null,
          prefill: null,
          timeout: null,
          tabId: TAB,
          at: Date.now(),
        },
      ],
    });
    render(<ExtensionDialog />);
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
    useAppStore.setState({
      extensionDialogs: [
        {
          id: "ui-3",
          method: "input",
          title: "Name",
          options: [],
          message: "",
          placeholder: "e.g. report",
          prefill: null,
          timeout: null,
          tabId: TAB,
          at: Date.now(),
        },
      ],
    });
    render(<ExtensionDialog />);
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "report");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "oi.respond",
      params: { id: "ui-3", value: "report" },
    });
  });

  it("cancels when the extension's timeout expires", () => {
    vi.useFakeTimers();
    try {
      const request = stubRequest();
      useAppStore.setState({
        extensionDialogs: [
          {
            id: "ui-4",
            method: "select",
            title: "Pick",
            options: ["a", "b"],
            message: "",
            placeholder: null,
            prefill: null,
            timeout: 1000,
            tabId: TAB,
            at: Date.now(),
          },
        ],
      });
      render(<ExtensionDialog />);
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
});

describe("StatusBar and notification centre", () => {
  it("shows extension status entries for the active tab", () => {
    useAppStore.setState({
      extensionUi: {
        [TAB]: {
          statuses: { build: "passing" },
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
    expect(screen.getByTestId("extension-status-build")).toHaveTextContent("passing");
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

  it("keeps a tool card collapsed by default", () => {
    render(
      <ToolCard
        tool={{
          toolCallId: "t",
          toolName: "read",
          args: {},
          done: true,
          isError: false,
          resultText: "hidden output",
        }}
      />,
    );
    expect(screen.queryByText("hidden output")).toBeNull();
  });
});
