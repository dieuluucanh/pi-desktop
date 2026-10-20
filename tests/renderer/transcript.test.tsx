import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEventEntry } from "../../src/shared/session-ipc";
import { Transcript, toolSummary } from "../../src/renderer/src/session/Transcript";
import {
  createTranscriptState,
  hydrateMessages,
  reduceSessionEvents,
  type TranscriptItem,
} from "../../src/renderer/src/session/session-events";
import { installBridge } from "./fixtures";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { TRANSCRIPT_10K_ITEMS } from "../../src/shared/performance";

/**
 * Transcript rendering (plan step 5). The fixture below drives the *real*
 * reducer, so these tests cover the whole path a live session takes: event
 * batches → items → what the user reads.
 */

const FIXTURE: SessionEventEntry[] = [
  { event: "message_start", payload: { message: { role: "user", content: "please fix the bug" } } },
  {
    event: "message_end",
    payload: { message: { role: "user", content: "please fix the bug" } },
  },
  { event: "message_start", payload: { message: { role: "assistant" } } },
  {
    event: "message_update",
    payload: {
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "look at the diff" },
    },
  },
  {
    event: "message_update",
    payload: { assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
  },
  {
    event: "message_update",
    payload: {
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "I **fixed** it" },
    },
  },
  {
    event: "message_end",
    payload: {
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "look at the diff" },
          { type: "text", text: "I **fixed** it" },
        ],
      },
    },
  },
  {
    event: "tool_execution_start",
    payload: {
      toolCallId: "t1",
      toolName: "edit",
      args: { path: "src/app.ts", oldString: "const a = 1;", newString: "const a = 2;" },
    },
  },
  {
    event: "tool_execution_end",
    payload: { toolCallId: "t1", result: { content: [{ type: "text", text: "applied" }] } },
  },
  {
    event: "tool_execution_start",
    payload: { toolCallId: "t2", toolName: "bash", args: { command: "npm test" } },
  },
  {
    event: "tool_execution_end",
    payload: {
      toolCallId: "t2",
      isError: true,
      result: { content: [{ type: "text", text: "1 failing" }] },
    },
  },
  { event: "session.crashed", payload: { code: 1 } },
  { event: "compaction_end", payload: { result: { summary: "condensed history" } } },
  {
    event: "entry_appended",
    payload: {
      entry: { type: "custom_message", id: "c1", customType: "todo", content: "3 items left" },
    },
  },
];

function fixtureItems(): TranscriptItem[] {
  return reduceSessionEvents(createTranscriptState(), FIXTURE).items;
}

describe("transcript rendering", () => {
  it("renders every item kind a session can produce", () => {
    const { container } = render(<Transcript items={fixtureItems()} />);

    expect(screen.getByText("please fix the bug")).toBeInTheDocument();
    expect(container.textContent).toContain("I ");
    expect(screen.getByText("fixed")).toBeInTheDocument(); // markdown bold, not literal asterisks
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("look at the diff")).toBeInTheDocument();
    expect(screen.getByText("The host process crashed")).toBeInTheDocument();
    expect(screen.getByText("Context compacted")).toBeInTheDocument();
    expect(screen.getByText("3 items left")).toBeInTheDocument();
    expect(screen.getByText("todo")).toBeInTheDocument();
  });

  it("shows a diff for an edit tool and marks a failing tool", async () => {
    const user = userEvent.setup();
    const { container } = render(<Transcript items={fixtureItems()} />);

    const cards = container.querySelectorAll("[aria-expanded]");
    expect(cards.length).toBeGreaterThanOrEqual(2);

    // The successful edit card starts collapsed, so opening it is what reveals
    // the diff (the failing bash card starts expanded because it failed).
    await user.click(screen.getAllByRole("button", { name: /edit/i })[0]!);
    expect(container.textContent).toContain("const a = 1;");
    expect(container.textContent).toContain("const a = 2;");
    expect(container.textContent).toContain("1 failing");
  });

  it("marks the assistant message as streaming while deltas are still arriving", () => {
    const state = reduceSessionEvents(createTranscriptState(), [
      { event: "message_start", payload: { message: { role: "assistant" } } },
      {
        event: "message_update",
        payload: { assistantMessageEvent: { type: "text_delta", delta: "partial" } },
      },
    ]);
    const { container } = render(<Transcript items={state.items} />);
    expect(container.textContent).toContain("partial");
    expect(container.textContent).toContain("▍");
  });

  it("shows the empty state with the session's folder and input hints", () => {
    const { container } = render(
      <Transcript items={[]} empty={{ cwd: "C:\\work\\app", project: "C:\\work\\app" }} />,
    );
    expect(screen.getByText("This session is ready")).toBeInTheDocument();
    expect(container.textContent).toContain("C:\\work\\app");
    expect(container.textContent).toContain("commands");
  });

  it("offers an abort action on an error notice while the run is active", () => {
    const items = reduceSessionEvents(createTranscriptState(), [
      { event: "extension_error", payload: { error: "boom" } },
    ]).items;
    const calls: number[] = [];
    render(<Transcript items={items} running onAbort={() => calls.push(1)} />);
    screen.getByRole("button", { name: /abort run/i }).click();
    expect(calls).toHaveLength(1);
  });

  it("copies a finished message's text", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<Transcript items={fixtureItems()} />);

    const copyButtons = screen.getAllByRole("button", { name: /^copy$/ });
    expect(copyButtons.length).toBeGreaterThan(0);
    await user.click(copyButtons[0]!);
    expect(writeText).toHaveBeenCalledWith("please fix the bug");
  });

  it("uses a plain list for small transcripts and still exposes the rows", () => {
    render(<Transcript items={fixtureItems()} />);
    const list = screen.getByTestId("transcript");
    expect(within(list).getByText("please fix the bug")).toBeInTheDocument();
  });

  it("lazily fetches a spilled large tool result only when its card is opened", async () => {
    const user = userEvent.setup();
    const handles = installBridge();
    const request = vi.fn(async () => ({
      path: "C:\\blobs\\big.json",
      contents: JSON.stringify({ content: [{ type: "text", text: "the whole 50 MB log" }] }),
    }));
    (handles.bridge.sessions as unknown as { request: unknown }).request = request;
    useAppStore.setState({ blobs: {} });

    const items = reduceSessionEvents(createTranscriptState(), [
      {
        event: "tool_execution_start",
        payload: { toolCallId: "t9", toolName: "bash", args: { command: "cat huge.log" } },
      },
      {
        event: "tool_execution_end",
        // What the host writes for an oversized result (plan step 24).
        payload: { toolCallId: "t9", result: { $blob: "C:\\blobs\\big.json", bytes: 50_000_000 } },
      },
    ]).items;

    render(<Transcript items={items} tabId="tab-1" />);
    // Collapsed: nothing is read from the blob cache yet.
    expect(request).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /bash/i }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "tab-1",
        method: "host.blobs.read",
        params: { path: "C:\\blobs\\big.json" },
      }),
    );
    expect(await screen.findByText("the whole 50 MB log")).toBeInTheDocument();
  });

  it("virtualizes a 10k-entry transcript instead of mounting every row", () => {
    const items: TranscriptItem[] = Array.from({ length: TRANSCRIPT_10K_ITEMS }, (_, index) => ({
      kind: "notice",
      id: `item-${index}`,
      notice: {
        id: `notice-${index}`,
        severity: "info",
        event: "notice",
        text: `notice ${index}`,
      },
    }));

    const { container } = render(<Transcript items={items} />);

    // The window renders a bounded slice; the scroll height proves the rest of
    // the 10k items are addressable without being in the DOM (60 fps bar).
    const rows = container.querySelectorAll("[data-index]");
    expect(rows.length).toBeLessThan(200);

    const list = screen.getByTestId("transcript");
    const spacer = list.firstElementChild as HTMLElement | null;
    expect(spacer).not.toBeNull();
    expect(Number.parseInt(spacer?.style.height ?? "0", 10)).toBeGreaterThan(100_000);
    // A row far outside the window never mounts, however large the session is.
    expect(container.textContent).not.toContain("notice 9999");
  });
});

describe("tool summaries", () => {
  it("prefers the most meaningful argument", () => {
    expect(
      toolSummary({
        toolCallId: "1",
        toolName: "read",
        args: { path: "src/a.ts" },
        isError: false,
        done: true,
        version: 1,
      }),
    ).toBe("src/a.ts");
    expect(
      toolSummary({
        toolCallId: "2",
        toolName: "bash",
        args: { command: "npm test" },
        isError: false,
        done: true,
        version: 1,
      }),
    ).toBe("npm test");
    expect(
      toolSummary({
        toolCallId: "3",
        toolName: "weird",
        args: {},
        isError: false,
        done: true,
        version: 1,
      }),
    ).toBe("");
  });
});

/* ------------------------------------------------------------------------- *
 * Extension-owned renderers (plan step 18)
 * ------------------------------------------------------------------------- */

const RENDER_TAB = "tab-render";

function stubRender(impl: (method: string, params?: unknown) => Promise<unknown>) {
  const request = vi.fn((input: { method: string; params?: unknown }) =>
    impl(input.method, input.params),
  );
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

function itemsOf(events: SessionEventEntry[]): TranscriptItem[] {
  return reduceSessionEvents(createTranscriptState(), events).items;
}

describe("extension renderers", () => {
  beforeEach(() => {
    installBridge();
    stubRender(async (method, params) => {
      if (method === "render.request") {
        const type = (params as { type?: string } | undefined)?.type;
        if (type === "bash") {
          return { rendered: true, width: 40, lines: ["\x1b[32mcustom bash render\x1b[0m"] };
        }
        if (type === "todo") return { rendered: true, width: 40, lines: ["custom todo render"] };
        return { rendered: false, width: 40, lines: [] };
      }
      if (method === "render.markdown") {
        const text = (params as { text?: string }).text ?? "";
        return { text: text.replace("fixed", "TRANSFORMED"), transformed: true };
      }
      return {};
    });
  });

  it("shows an extension's ANSI frame for a tool that ships a renderer", async () => {
    const items = itemsOf([
      {
        event: "tool_execution_start",
        payload: { toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
      },
      {
        event: "tool_execution_end",
        payload: { toolCallId: "t1", result: { content: [{ type: "text", text: "ok" }] } },
      },
    ]);
    render(<Transcript items={items} tabId={RENDER_TAB} toolsExpanded />);

    expect(await screen.findByText("custom bash render")).toBeInTheDocument();
  });

  it("keeps the native card for a tool without a renderer", async () => {
    const items = itemsOf([
      {
        event: "tool_execution_start",
        payload: { toolCallId: "t2", toolName: "read", args: { path: "src/a.ts" } },
      },
      {
        event: "tool_execution_end",
        payload: { toolCallId: "t2", result: { content: [{ type: "text", text: "file body" }] } },
      },
    ]);
    render(<Transcript items={items} tabId={RENDER_TAB} toolsExpanded />);

    expect(await screen.findByText("file body")).toBeInTheDocument();
    expect(screen.queryByText("custom bash render")).not.toBeInTheDocument();
  });

  it("renders a custom message through registerMessageRenderer", async () => {
    const items = itemsOf([
      {
        event: "entry_appended",
        payload: {
          entry: { type: "custom_message", id: "c1", customType: "todo", content: "3 items" },
        },
      },
    ]);
    render(<Transcript items={items} tabId={RENDER_TAB} />);

    expect(await screen.findByText("custom todo render")).toBeInTheDocument();
  });

  it("applies a registered markdown transformer to assistant output", async () => {
    const items = itemsOf([
      { event: "message_start", payload: { message: { role: "assistant" } } },
      {
        event: "message_end",
        payload: { message: { role: "assistant", content: "I fixed it" } },
      },
    ]);
    render(<Transcript items={items} tabId={RENDER_TAB} />);

    expect(await screen.findByText(/TRANSFORMED/)).toBeInTheDocument();
  });

  it("renders nothing for a rendererless bare custom entry", async () => {
    // The exact user-visible bug this fixes: pressing Tab made the workflow
    // extension append `pi.appendEntry("workflow", …)`, and the transcript
    // rendered a dashed card headed with the literal customType.
    const items = itemsOf([
      {
        event: "entry_appended",
        payload: {
          entry: { type: "custom", id: "w1", customType: "workflow", data: { mode: "plan" } },
        },
      },
    ]);
    render(<Transcript items={items} tabId={RENDER_TAB} />);

    // The stub renderer answers `rendered: false` for anything but bash/todo.
    await vi.waitFor(() => {
      expect(screen.queryByText("workflow")).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/workflow-plane/)).not.toBeInTheDocument();
  });

  it("hides the workflow extension's display:false context on reload", async () => {
    // Reloaded history must not resurrect the plan-mode context as an assistant
    // bubble — the second half of the same bug.
    const items = hydrateMessages(createTranscriptState(), [
      {
        id: "h1",
        role: "custom_message",
        customType: "workflow-plan-context",
        content: "[PLAN MODE ACTIVE]",
        display: false,
      },
    ]).items;
    render(<Transcript items={items} tabId={RENDER_TAB} />);

    expect(screen.queryByText(/PLAN MODE ACTIVE/)).not.toBeInTheDocument();
  });
});
