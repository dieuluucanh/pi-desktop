import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionEventEntry } from "../../src/shared/session-ipc";
import { Transcript, toolSummary } from "../../src/renderer/src/session/Transcript";
import {
  createTranscriptState,
  reduceSessionEvents,
  type TranscriptItem,
} from "../../src/renderer/src/session/session-events";

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
      }),
    ).toBe("src/a.ts");
    expect(
      toolSummary({
        toolCallId: "2",
        toolName: "bash",
        args: { command: "npm test" },
        isError: false,
        done: true,
      }),
    ).toBe("npm test");
    expect(
      toolSummary({ toolCallId: "3", toolName: "weird", args: {}, isError: false, done: true }),
    ).toBe("");
  });
});
