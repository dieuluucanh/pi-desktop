import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import { SessionView } from "../../src/renderer/src/views/SessionView";
import { ShortcutDispatcher } from "../../src/renderer/src/shortcuts/ShortcutDispatcher";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { EMPTY_EXTENSION_UI } from "../../src/shared/extension-ui";
import { EMPTY_TUI_SURFACE } from "../../src/shared/tui-surface";
import {
  REVIEW_HANDOFF_LINE,
  REVIEW_PAUSED_LINE,
  REVIEW_RUNNING_HINT,
  REVIEW_RUNNING_LINE,
} from "../../src/shared/workflow-mode";
import { documentsViewFixture, installBridge } from "./fixtures";
import {
  WORKSPACE_PATH_DRAG_MIME,
  WORKSPACE_PATH_DRAG_VERSION,
  serializeWorkspaceDrag,
  type WorkspaceDragPayload,
} from "../../src/shared/workspace-drag";

/**
 * The session view's chrome (plan step 6).
 *
 * The header used to pack eight differently-styled controls, including a
 * native `<select>` that matched nothing beside it. The cluster is now one row
 * of equally-weighted buttons; Ctrl+O is the only tool-detail switch.
 */

const TAB = "tab-1";

function fakeWorkspaceDrop(
  overrides: Partial<WorkspaceDragPayload> = {},
  types: string[] = [WORKSPACE_PATH_DRAG_MIME],
) {
  const payload: WorkspaceDragPayload = {
    version: WORKSPACE_PATH_DRAG_VERSION,
    projectPath: "C:/work/app",
    path: "src/notes.md",
    kind: "file",
    ...overrides,
  };
  return {
    types,
    files: [] as File[],
    dropEffect: "none",
    effectAllowed: "none",
    getData: (type: string) =>
      type === WORKSPACE_PATH_DRAG_MIME ? serializeWorkspaceDrag(payload) : "",
    setData: () => undefined,
  };
}

function resetStore(): void {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
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
    draftHistory: {},
    historySeed: {},
    historyBrowse: {},
  });
}

beforeEach(() => {
  resetStore();
});

describe("session chrome", () => {
  it("has no visible session header; the heading stays for assistive tech", () => {
    render(<SessionView tabId={TAB} />);
    // The tab strip owns the visible title and status; the view keeps only a
    // screen-reader heading so it still has an accessible name.
    expect(screen.queryByTitle("Session status: ready")).toBeNull();
    expect(screen.getByRole("heading", { name: "Fix the bug" })).toHaveClass("sr-only");
  });

  it("keeps the model/thinking/context controls beside the composer", () => {
    render(<SessionView tabId={TAB} />);
    const tools = screen.getByTestId("composer-tools");
    expect(within(tools).getByRole("button", { name: "Change model" })).toBeInTheDocument();
    expect(within(tools).getByTestId("composer-thinking")).toHaveAttribute(
      "aria-label",
      "Thinking level",
    );
    expect(within(tools).getByTestId("context-ring")).toHaveClass("size-7");
    expect(within(tools).getByRole("button", { name: "Change model" })).toHaveClass("h-7", "w-7");
    expect(within(tools).getByTestId("composer-thinking")).toHaveClass("h-7", "w-7");
    expect(tools).toHaveClass("h-7");
  });

  it("shows the thinking level as a brain icon, not a text label", () => {
    render(<SessionView tabId={TAB} />);
    const thinking = screen.getByTestId("composer-thinking");
    expect(thinking.textContent).toBe("");
    expect(thinking.querySelector("[data-testid='brain']")).not.toBeNull();
    expect(thinking).toHaveAttribute(
      "title",
      [
        "Thinking level",
        "This model does not report a thinking level.",
        "Model: anthropic/claude",
      ].join("\n"),
    );
  });

  it("keeps the model and thinking tooltips in step with the live pair", () => {
    render(<SessionView tabId={TAB} />);
    act(() => {
      useAppStore.getState().applySessionState({
        tabId: TAB,
        state: {
          model: { provider: "synthetic", id: "deepseek" },
          thinkingLevel: "max",
          thinkingLevels: ["off", "low", "high", "xhigh", "max"],
        },
      });
    });

    const model = screen.getByTestId("composer-model");
    const thinking = screen.getByTestId("composer-thinking");
    expect(model).toHaveAttribute("title", "synthetic/deepseek · thinking max");
    expect(thinking).toHaveAttribute(
      "title",
      [
        "Thinking: max (full)",
        "Maximum reasoning effort",
        "Model: synthetic/deepseek",
        "Supports: off, low, high, xhigh, max",
      ].join("\n"),
    );
    expect(thinking.querySelector("[data-testid='brain']")).toHaveAttribute("data-fill", "4");
  });

  it("shows the live model in the icon's tooltip, not as a label", () => {
    // The tab spawned on one model; the host has since switched (plan step 1).
    useAppStore.setState({
      sessionStates: { [TAB]: { model: { provider: "opencode-go", id: "other-model" } } },
    });
    render(<SessionView tabId={TAB} />);
    const model = screen.getByRole("button", { name: "Change model" });
    expect(model).toHaveAttribute("title", "opencode-go/other-model");
    // An icon, not a long label: the visible text is gone.
    expect(model.textContent).toBe("");
  });

  it("updates the model tooltip when a host state frame reports a change", () => {
    render(<SessionView tabId={TAB} />);
    act(() => {
      useAppStore.getState().applySessionState({
        tabId: TAB,
        state: { model: { provider: "openai", id: "gpt-5" } },
      });
    });
    expect(screen.getByRole("button", { name: "Change model" })).toHaveAttribute(
      "title",
      "openai/gpt-5",
    );
  });

  it("keeps the error banner's Restart when the host crashed", () => {
    useAppStore.setState({
      tabs: [{ ...useAppStore.getState().tabs[0]!, status: "crashed", error: "host failed" }],
    });
    render(<SessionView tabId={TAB} />);
    expect(screen.getByText("host failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();
  });

  it("keeps every line of a session error", () => {
    useAppStore.setState({
      tabs: [
        {
          ...useAppStore.getState().tabs[0]!,
          status: "crashed",
          error: "host failed\nsecond line",
        },
      ],
    });
    render(<SessionView tabId={TAB} />);

    const message = screen.getByText(/host failed\s+second line/);
    expect(message.className).toContain("whitespace-pre-wrap");
    expect(message.className).toContain("break-words");
    expect(message.textContent).toBe("host failed\nsecond line");
    expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();
  });

  it("has no view-mode control; Ctrl+O is the only tool-detail switch", () => {
    render(
      <>
        <SessionView tabId={TAB} />
        <ShortcutDispatcher />
      </>,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "View mode" })).toBeNull();

    fireEvent.keyDown(document.body, { key: "o", ctrlKey: true });
    expect(useAppStore.getState().toolsExpanded[TAB]).toBe(true);
    fireEvent.keyDown(document.body, { key: "o", ctrlKey: true });
    expect(useAppStore.getState().toolsExpanded[TAB]).toBe(false);
  });
});

describe("extension footer and widget placement (minimal-session-ui step 7)", () => {
  const frame = (seq: number, text: string) => ({
    seq,
    width: 20,
    height: 1,
    lines: [text],
    cursor: null,
  });

  it("lets an extension footer replace the built-in footer instead of stacking", () => {
    useAppStore.setState({
      tuiSurfaces: {
        [TAB]: {
          ...EMPTY_TUI_SURFACE,
          active: true,
          footer: frame(1, "EXT FOOTER"),
        },
      },
      extensionUi: { [TAB]: { ...EMPTY_EXTENSION_UI, statuses: { probe: "on" } } },
    });

    render(<SessionView tabId={TAB} />);
    expect(screen.getByText("EXT FOOTER")).toBeInTheDocument();
    // The built-in rows are gone, not duplicated.
    expect(screen.queryByTestId("session-footer")).toBeNull();
    // A custom footer owns the statuses (Pi hands it the FooterDataProvider).
    expect(screen.queryByTestId("extension-status-probe")).toBeNull();
  });

  it("renders the built-in footer and its statuses when no extension footer is set", () => {
    useAppStore.setState({
      extensionUi: { [TAB]: { ...EMPTY_EXTENSION_UI, statuses: { probe: "on" } } },
    });

    render(<SessionView tabId={TAB} />);
    expect(screen.getByTestId("session-footer")).toBeInTheDocument();
    expect(screen.getByTestId("extension-status-probe")).toHaveTextContent("on");
  });

  it("keeps extension widgets in Pi's above/below editor positions", () => {
    useAppStore.setState({
      tuiSurfaces: {
        [TAB]: {
          ...EMPTY_TUI_SURFACE,
          active: true,
          widgetsAbove: [frame(1, "ABOVE WIDGET")],
          widgetsBelow: [frame(2, "BELOW WIDGET")],
        },
      },
    });

    render(<SessionView tabId={TAB} />);
    expect(screen.getByText("ABOVE WIDGET")).toBeInTheDocument();
    expect(screen.getByText("BELOW WIDGET")).toBeInTheDocument();
  });

  it("puts a one-line below-editor widget in the footer and keeps multi-line ones in the strip", () => {
    useAppStore.setState({
      tuiSurfaces: {
        [TAB]: {
          ...EMPTY_TUI_SURFACE,
          active: true,
          widgetsBelow: [
            frame(1, "ONE-LINE PI-LENS"),
            {
              seq: 2,
              width: 20,
              height: 2,
              lines: ["MULTI-LINE 1", "MULTI-LINE 2"],
              cursor: null,
            },
          ],
        },
      },
    });

    render(<SessionView tabId={TAB} />);
    const footer = screen.getByTestId("session-footer");
    const inline = screen.getByTestId("inline-widget-1");
    expect(footer.contains(inline)).toBe(true);
    expect(inline).toHaveTextContent("ONE-LINE PI-LENS");

    const multi = screen.getByText("MULTI-LINE 1");
    expect(footer.contains(multi)).toBe(false);
    expect(multi.closest("[data-tui-widgets='belowEditor']")).not.toBeNull();
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
    render(<SessionView tabId={TAB} />);

    const prompt = screen.getByLabelText("Prompt");
    await userEvent.type(prompt, "#");

    // The completion item's label carries the `#` the user typed.
    expect(await screen.findByText("#Book1.xlsx")).toBeInTheDocument();
    expect(screen.getByTestId("completion-overlay")).toBeInTheDocument();
  });

  it("lists nothing in a sibling session of the same project", async () => {
    seedHost(false);
    render(<SessionView tabId={TAB} />);

    const prompt = screen.getByLabelText("Prompt");
    await userEvent.type(prompt, "#");

    // The `office_*` call would land on the other tab, so the menu offers
    // nothing rather than a document this session cannot serve.
    await waitFor(() => expect(screen.queryByTestId("completion-overlay")).not.toBeInTheDocument());
    expect(screen.queryByText("#Book1.xlsx")).not.toBeInTheDocument();
  });
});

describe("workspace drops on the session pane", () => {
  it("inserts a mention when a file is dropped on the transcript", async () => {
    render(<SessionView tabId={TAB} />);

    fireEvent.drop(screen.getByTestId("session-view"), {
      dataTransfer: fakeWorkspaceDrop(),
    });

    await waitFor(() =>
      expect(useAppStore.getState().prefs.drafts[TAB]).toContain("@src/notes.md"),
    );
  });

  it("shows and clears the drop overlay", async () => {
    render(<SessionView tabId={TAB} />);
    const view = screen.getByTestId("session-view");

    fireEvent.dragEnter(view, { dataTransfer: fakeWorkspaceDrop() });
    expect(screen.getByText(/Drop to mention this file/)).toBeInTheDocument();

    fireEvent.dragLeave(view, { dataTransfer: fakeWorkspaceDrop() });
    await waitFor(() =>
      expect(screen.queryByText(/Drop to mention this file/)).not.toBeInTheDocument(),
    );
  });

  it("refuses a file from a different project", () => {
    render(<SessionView tabId={TAB} />);
    useAppStore.setState({ hint: null });

    fireEvent.drop(screen.getByTestId("session-view"), {
      dataTransfer: fakeWorkspaceDrop({ projectPath: "C:/other" }),
    });

    expect(useAppStore.getState().prefs.drafts[TAB] ?? "").toBe("");
    expect(useAppStore.getState().hint).toMatch(/different folder/);
  });

  it("ignores an in-app text drag", () => {
    render(<SessionView tabId={TAB} />);
    const view = screen.getByTestId("session-view");

    fireEvent.dragEnter(view, {
      dataTransfer: fakeWorkspaceDrop({}, ["text/plain"]),
    });
    expect(screen.queryByText(/Drop to mention this file/)).not.toBeInTheDocument();
  });
});

/**
 * The grid renders several session views at once (2026-11-03 plan). Each one must
 * read its own tab's state, never the app-wide selection, or two panes would show
 * the same conversation.
 */
describe("two panes at once", () => {
  const OTHER = "tab-2";

  function twoTabs(): void {
    installBridge();
    useAppStore.setState({
      prefs: { ...DEFAULT_PREFS, drafts: {} },
      tabs: [
        {
          id: TAB,
          kind: "session",
          cwd: "C:/work/app",
          title: "First session",
          sessionFile: null,
          status: "idle",
          createdAt: 1,
          lastActiveAt: 1,
          model: "anthropic/claude",
        },
        {
          id: OTHER,
          kind: "session",
          cwd: "C:/work/other",
          title: "Second session",
          sessionFile: null,
          status: "idle",
          createdAt: 2,
          lastActiveAt: 2,
          model: "anthropic/claude",
        },
      ],
      activeTabId: TAB,
      transcripts: {},
      sessionStates: {},
      extensionUi: {},
      tuiSurfaces: {},
      picker: null,
      pickerTabId: null,
      draftHistory: {},
      historySeed: {},
      historyBrowse: {},
    });
  }

  it("renders each tab's own heading and draft", () => {
    twoTabs();
    useAppStore.setState({
      prefs: { ...DEFAULT_PREFS, drafts: { [TAB]: "first", [OTHER]: "second" } },
    });

    render(
      <>
        <SessionView tabId={TAB} />
        <SessionView tabId={OTHER} />
      </>,
    );

    expect(screen.getByRole("heading", { name: "First session" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Second session" })).toBeInTheDocument();
    const composers = screen.getAllByLabelText("Prompt");
    expect(composers).toHaveLength(2);
    expect(composers[0]).toHaveValue("first");
    expect(composers[1]).toHaveValue("second");
  });

  it("keeps history browsing in the pane that pressed the arrow", async () => {
    const user = userEvent.setup();
    twoTabs();
    useAppStore.setState({
      prefs: { ...DEFAULT_PREFS, drafts: { [TAB]: "first draft", [OTHER]: "second draft" } },
      draftHistory: { [TAB]: ["first history"], [OTHER]: ["second history"] },
      historyBrowse: {},
    });

    render(
      <>
        <SessionView tabId={TAB} />
        <SessionView tabId={OTHER} />
      </>,
    );

    const [first, second] = screen.getAllByLabelText("Prompt") as HTMLTextAreaElement[];
    await user.click(first!);
    first!.setSelectionRange(first!.value.length, first!.value.length);

    await user.keyboard("{ArrowUp}");

    expect(first).toHaveValue("first history");
    expect(second).toHaveValue("second draft");
    expect(useAppStore.getState().prefs.drafts[OTHER]).toBe("second draft");
    expect(useAppStore.getState().historyBrowse[OTHER]).toBeUndefined();
  });

  it("explains a slow open and cancels it", async () => {
    resetStore();
    useAppStore.setState({
      tabs: [{ ...useAppStore.getState().tabs[0]!, status: "starting" }],
    });
    const stop = vi.fn(async () => ({
      tabs: useAppStore.getState().tabs,
      activeTabId: TAB,
    }));
    (window.pi as unknown as { sessions: { stop: unknown } }).sessions.stop = stop;

    render(<SessionView tabId={TAB} />);

    expect(screen.getByTestId("session-starting")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("session-starting-cancel"));
    await waitFor(() => expect(stop).toHaveBeenCalledWith(TAB));
  });

  it("opens the model picker only in the pane that asked", () => {
    twoTabs();

    render(
      <>
        <SessionView tabId={TAB} />
        <SessionView tabId={OTHER} />
      </>,
    );

    const tools = screen.getAllByTestId("composer-tools");
    expect(tools).toHaveLength(2);
    fireEvent.click(within(tools[0]!).getByRole("button", { name: "Change model" }));

    expect(useAppStore.getState().pickerTabId).toBe(TAB);
  });
});

/**
 * Prompt history (2026-11-07 plan): `ArrowUp` recalls a sent prompt and
 * `ArrowDown` must restore the draft that was being typed, including its caret.
 */
describe("prompt history", () => {
  it("restores the pending draft after recalling a previous prompt", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ draftHistory: { [TAB]: ["older prompt"] }, historyBrowse: {} });
    render(<SessionView tabId={TAB} />);

    const prompt = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await user.click(prompt);
    await user.type(prompt, "pending prompt");

    await user.keyboard("{ArrowUp}");
    expect(prompt).toHaveValue("older prompt");

    await user.keyboard("{ArrowDown}");
    expect(prompt).toHaveValue("pending prompt");
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("pending prompt");
  });

  it("restores the caret inside a multi-line draft", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ draftHistory: { [TAB]: ["older prompt"] }, historyBrowse: {} });
    render(<SessionView tabId={TAB} />);

    const prompt = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await user.click(prompt);
    fireEvent.change(prompt, { target: { value: "first line\nsecond line" } });
    prompt.setSelectionRange(4, 4);

    await user.keyboard("{ArrowUp}");
    expect(prompt).toHaveValue("older prompt");

    await user.keyboard("{ArrowDown}");
    expect(prompt).toHaveValue("first line\nsecond line");
    expect(prompt.selectionStart).toBe(4);
  });

  it("recalls a resumed session's prompts after hydration", async () => {
    const user = userEvent.setup();
    (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = vi.fn(
      async (input: { method: string }) =>
        input.method === "messages.get"
          ? {
              messages: [{ id: "m1", role: "user", content: "prompt from before the restart" }],
            }
          : {},
    );

    render(<SessionView tabId={TAB} />);
    await waitFor(() => expect(useAppStore.getState().transcripts[TAB]?.hydrated).toBe(true));

    const prompt = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await user.click(prompt);
    await user.type(prompt, "pending draft");

    // The session-derived seed is what makes this work after a restart.
    await user.keyboard("{ArrowUp}");
    expect(prompt).toHaveValue("prompt from before the restart");

    await user.keyboard("{ArrowDown}");
    expect(prompt).toHaveValue("pending draft");
  });

  it("leaves the draft alone when Up is pressed before hydration finishes", async () => {
    const user = userEvent.setup();
    let resolveMessages: (messages: unknown[]) => void = () => undefined;
    const pending = new Promise<unknown[]>((resolve) => {
      resolveMessages = resolve;
    });
    (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = vi.fn(
      async (input: { method: string }) =>
        input.method === "messages.get" ? { messages: await pending } : {},
    );

    render(<SessionView tabId={TAB} />);
    const prompt = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await user.click(prompt);
    await user.type(prompt, "pending draft");

    // No seed yet: Up must stay a native caret move and keep the draft.
    await user.keyboard("{ArrowUp}");
    expect(prompt).toHaveValue("pending draft");

    await act(async () => {
      resolveMessages([{ id: "m1", role: "user", content: "older prompt" }]);
      await pending;
    });
    await waitFor(() => expect(useAppStore.getState().transcripts[TAB]?.hydrated).toBe(true));

    await user.keyboard("{ArrowUp}");
    expect(prompt).toHaveValue("older prompt");
    await user.keyboard("{ArrowDown}");
    expect(prompt).toHaveValue("pending draft");
  });
});

describe("Escape parity (plan step 24)", () => {
  function runningTab() {
    useAppStore.setState({
      tabs: useAppStore.getState().tabs.map((tab) => ({ ...tab, status: "running" })),
    });
  }

  it("sends composer Escape through interruptRun, not stopRun", async () => {
    const user = userEvent.setup();
    const interrupt = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    useAppStore.setState({ interruptRun: interrupt, stopRun: stop });
    runningTab();

    render(<SessionView tabId={TAB} />);
    await user.click(screen.getByLabelText("Prompt"));
    await user.keyboard("{Escape}");

    expect(interrupt).toHaveBeenCalledWith(TAB);
    expect(stop).not.toHaveBeenCalled();
  });

  it("sends transcript Escape through the global interrupt too", () => {
    const interrupt = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    useAppStore.setState({ interruptRun: interrupt, stopRun: stop });
    runningTab();

    render(
      <>
        <SessionView tabId={TAB} />
        <ShortcutDispatcher />
      </>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(interrupt).toHaveBeenCalledWith(TAB, expect.objectContaining({ key: "Escape" }));
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not intercept Escape outside a running session", () => {
    const interrupt = vi.fn(async () => {});
    useAppStore.setState({ interruptRun: interrupt });

    render(
      <>
        <SessionView tabId={TAB} />
        <ShortcutDispatcher />
      </>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });

    // The dispatcher forwards; the store decides (an idle tab is a no-op).
    expect(interrupt).toHaveBeenCalled();
    expect(useAppStore.getState().tabs[0]?.status).toBe("idle");
  });
});

describe("extension-owned review status (2026-11-10; one row 2026-11-18)", () => {
  const reviewing = {
    message: REVIEW_RUNNING_LINE,
    visible: null,
    frames: null,
    intervalMs: null,
  };
  const REVIEW_LINE = `${REVIEW_RUNNING_LINE} · pass 2/2 · 1 finding · ● verifying`;
  const reviewStatus = (workflow: string, line: string | null = REVIEW_LINE) => ({
    ...EMPTY_EXTENSION_UI,
    statuses: {
      workflow,
      ...(line === null ? {} : { "workflow-review": line }),
    },
    working: reviewing,
  });

  it("shows one review row for a manual review while the tab is idle", () => {
    useAppStore.setState({ extensionUi: { [TAB]: reviewStatus("🔍 review") } });

    render(<SessionView tabId={TAB} />);

    expect(screen.queryByTestId("extension-working-row")).toBeNull();
    expect(screen.getByTestId("review-bar")).toHaveAttribute("data-phase", "running");
    expect(screen.getByTestId("review-bar")).toHaveTextContent(REVIEW_LINE);
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abort" })).toBeInTheDocument();
    // The review row promotes `workflow-review`; the footer keeps only the mode.
    expect(screen.getByTestId("extension-status-workflow")).toHaveTextContent("🔍 review");
    expect(screen.queryByTestId("extension-status-workflow-review")).toBeNull();
    expect(useAppStore.getState().tabs[0]?.status).toBe("idle");
  });

  it("shows the full paused line and a Resume button while a review is paused", () => {
    useAppStore.setState({
      extensionUi: { [TAB]: reviewStatus("🔍 review — paused", REVIEW_PAUSED_LINE) },
    });

    render(<SessionView tabId={TAB} />);

    expect(screen.queryByTestId("extension-working-row")).toBeNull();
    expect(screen.getByTestId("review-bar")).toHaveTextContent(REVIEW_PAUSED_LINE);
    expect(screen.getByTestId("review-bar")).toHaveAttribute("data-phase", "paused");
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("keeps the handoff row alive after the reviewer finishes", () => {
    useAppStore.setState({
      extensionUi: {
        [TAB]: {
          ...EMPTY_EXTENSION_UI,
          statuses: {
            workflow: "🔍 review — awaiting decision",
            "workflow-review": REVIEW_HANDOFF_LINE,
          },
        },
      },
    });

    render(<SessionView tabId={TAB} />);

    expect(screen.getByTestId("review-bar")).toHaveAttribute("data-phase", "handoff");
    expect(screen.getByTestId("review-bar")).toHaveTextContent(REVIEW_HANDOFF_LINE);
    expect(screen.queryByTestId("extension-working-row")).toBeNull();
    expect(screen.queryByRole("button", { name: "Abort" })).toBeNull();
  });

  it("runs the review command without clearing the draft", async () => {
    const request = vi.fn(async (input: { method: string }) =>
      input.method === "commands.run" ? { ran: true } : {},
    );
    (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
    useAppStore.setState({ extensionUi: { [TAB]: reviewStatus("🔍 review") } });

    render(<SessionView tabId={TAB} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: TAB,
        method: "commands.run",
        params: { name: "review-pause", args: "", ack: "started" },
      }),
    );
  });

  it("focuses the linked loopback review tab from the handoff bar", async () => {
    useAppStore.setState({
      extensionUi: {
        [TAB]: {
          ...EMPTY_EXTENSION_UI,
          statuses: { workflow: "🔍 review — awaiting decision" },
        },
      },
      tabs: [
        ...useAppStore.getState().tabs,
        {
          id: "web-review",
          kind: "web" as const,
          cwd: "C:/work/app",
          title: "Review",
          sessionFile: null,
          status: "idle" as const,
          createdAt: 2,
          lastActiveAt: 2,
          model: null,
          url: "http://127.0.0.1:4317/review",
          sessionTabId: TAB,
        },
      ],
    });

    render(<SessionView tabId={TAB} />);
    fireEvent.click(screen.getByRole("button", { name: "Open review tab" }));

    await waitFor(() => expect(useAppStore.getState().activeTabId).toBe("web-review"));
  });

  it("falls back to the canonical line when the extension sends no workflow-review", () => {
    useAppStore.setState({
      extensionUi: {
        [TAB]: {
          ...EMPTY_EXTENSION_UI,
          statuses: { workflow: "🔍 review" },
          working: { ...reviewing, message: "🔍 Reviewing plan…" },
        },
      },
    });

    render(<SessionView tabId={TAB} />);

    expect(screen.getByTestId("review-bar")).toHaveTextContent(REVIEW_RUNNING_LINE);
    expect(screen.getByTestId("review-bar")).toHaveTextContent(REVIEW_RUNNING_HINT);
  });

  it("places the review row below the above-editor widgets and above the composer", () => {
    useAppStore.setState({
      extensionUi: { [TAB]: reviewStatus("🔍 review") },
      tuiSurfaces: {
        [TAB]: {
          ...EMPTY_TUI_SURFACE,
          active: true,
          widgetsAbove: [{ seq: 1, width: 20, height: 1, lines: ["TODO PANEL"], cursor: null }],
        },
      },
    });

    render(<SessionView tabId={TAB} />);

    const todo = screen.getByText("TODO PANEL");
    const bar = screen.getByTestId("review-bar");
    const composer = screen.getByTestId("composer-drop");
    expect(todo.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("mounts the todo bar above the panel and the review row", () => {
    useAppStore.setState({
      extensionUi: {
        [TAB]: {
          ...EMPTY_EXTENSION_UI,
          statuses: {
            workflow: "🔍 review",
            "workflow-todos": "☐ Todos 3/12 · expanded",
          },
        },
      },
      tuiSurfaces: {
        [TAB]: {
          ...EMPTY_TUI_SURFACE,
          active: true,
          widgetsAbove: [
            {
              seq: 1,
              key: "workflow-todos",
              width: 40,
              height: 2,
              lines: ["▶ 3. Build", "☐ 4. Test"],
              cursor: null,
            },
          ],
        },
      },
    });

    render(<SessionView tabId={TAB} />);

    const todoBar = screen.getByTestId("todo-panel-bar");
    const widget = screen.getByText("▶ 3. Build");
    const review = screen.getByTestId("review-bar");
    const composer = screen.getByTestId("composer-drop");
    expect(todoBar).toHaveTextContent("3/12");
    expect(todoBar.compareDocumentPosition(widget) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(widget.compareDocumentPosition(review) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      review.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The bar promotes the compact status; the footer omits its copy.
    expect(screen.queryByTestId("extension-status-workflow-todos")).toBeNull();
  });

  it("keeps the bar when the list is hidden and dispatches the toggle", async () => {
    const runTodoPanelAction = vi.fn(async (_tabId: string, _action: string) => true);
    const spy = vi
      .spyOn(
        useAppStore.getState() as unknown as {
          runTodoPanelAction: typeof runTodoPanelAction;
        },
        "runTodoPanelAction",
      )
      .mockImplementation(runTodoPanelAction);
    useAppStore.setState({
      extensionUi: {
        [TAB]: {
          ...EMPTY_EXTENSION_UI,
          statuses: {
            workflow: "▶ build 3/12",
            "workflow-todos": "☐ Todos 3/12 · hidden",
          },
        },
      },
    });

    try {
      render(<SessionView tabId={TAB} />);
      expect(screen.getByTestId("todo-panel-bar")).toHaveAttribute("data-state", "hidden");
      expect(screen.getByTestId("todo-panel-bar")).toHaveTextContent("Hidden");
      fireEvent.click(screen.getByTestId("todo-panel-bar-toggle"));
      await waitFor(() => expect(runTodoPanelAction).toHaveBeenCalledWith(TAB, "expand"));
    } finally {
      spy.mockRestore();
    }
  });

  it("degrades to no bar on an old extension's hidden Review panel", () => {
    useAppStore.setState({
      extensionUi: {
        [TAB]: {
          ...EMPTY_EXTENSION_UI,
          statuses: { workflow: "🔍 review" },
        },
      },
      tuiSurfaces: { [TAB]: { ...EMPTY_TUI_SURFACE, active: false } },
    });

    render(<SessionView tabId={TAB} />);

    // 0.12.1 carries no `workflow-todos` status and the hidden panel has no
    // frame; the menu/palette still dispatch /todos, but there is nothing to
    // anchor a native bar to. The documented degradation must not crash.
    expect(screen.queryByTestId("todo-panel-bar")).toBeNull();
    expect(screen.getByTestId("review-bar")).toBeInTheDocument();
  });

  it("keeps a residual workflow-review in the footer when no review row is visible", () => {
    useAppStore.setState({
      extensionUi: {
        [TAB]: {
          ...EMPTY_EXTENSION_UI,
          statuses: {
            workflow: "⏸ plan",
            "workflow-review": "handoff pending — browser",
          },
        },
      },
    });

    render(<SessionView tabId={TAB} />);

    expect(screen.queryByTestId("review-bar")).toBeNull();
    expect(screen.getByTestId("extension-status-workflow-review")).toHaveTextContent(
      "handoff pending — browser",
    );
  });

  it("hides the row when the extension hides its indicator", () => {
    useAppStore.setState({
      extensionUi: {
        [TAB]: {
          ...EMPTY_EXTENSION_UI,
          working: { ...reviewing, visible: false },
        },
      },
    });

    render(<SessionView tabId={TAB} />);

    expect(screen.queryByTestId("extension-working-row")).toBeNull();
  });

  it("keeps a genuinely idle tab empty", () => {
    render(<SessionView tabId={TAB} />);

    expect(screen.queryByTestId("extension-working-row")).toBeNull();
    expect(screen.queryByTestId("review-bar")).toBeNull();
  });
});
