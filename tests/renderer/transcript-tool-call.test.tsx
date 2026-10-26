import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Transcript } from "../../src/renderer/src/session/Transcript";
import type {
  TranscriptItem,
  TranscriptToolRun,
} from "../../src/renderer/src/session/session-events";

function messageWith(
  blocks: TranscriptItem extends never
    ? never
    : NonNullable<TranscriptItem>["kind"] extends never
      ? never
      : unknown,
): TranscriptItem {
  return {
    kind: "message",
    id: "message-1",
    message: {
      id: "message-1",
      role: "assistant",
      blocks: blocks as never,
      streaming: false,
    },
  };
}

function toolRun(overrides: Partial<TranscriptToolRun> = {}): TranscriptToolRun {
  return {
    toolCallId: "call-1",
    toolName: "read",
    isError: false,
    done: true,
    version: 1,
    args: { path: "note.txt" },
    resultText: "GIZMO",
    result: { content: [{ type: "text", text: "GIZMO" }] },
    ...overrides,
  };
}

describe("transcript tool calls and content order", () => {
  it("renders text and thinking in source order", () => {
    const { container } = render(
      <Transcript
        items={[
          messageWith([
            { kind: "text", text: "first" },
            { kind: "thinking", text: "why" },
            { kind: "text", text: "second" },
          ]),
        ]}
      />,
    );
    const text = container.textContent ?? "";
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("why"));
    expect(text.indexOf("why")).toBeLessThan(text.indexOf("second"));
  });

  it("hides the inline tool-call badge when a tool card exists", () => {
    render(
      <Transcript
        items={[
          messageWith([
            { kind: "text", text: "Reading" },
            {
              kind: "toolCall",
              id: "call-1",
              name: "read",
              arguments: '{"path":"note.txt"}',
              complete: true,
            },
          ]),
          { kind: "tool", id: "call-1", tool: toolRun() },
        ]}
      />,
    );
    expect(screen.queryByTestId("inline-tool-call")).toBeNull();
    expect(screen.getByTestId("tool-card")).toBeTruthy();
  });

  it("keeps the inline fallback when no tool run exists", () => {
    render(
      <Transcript
        items={[
          messageWith([
            { kind: "toolCall", id: "call-9", name: "read", arguments: "{}", complete: true },
          ]),
        ]}
      />,
    );
    expect(screen.getByTestId("inline-tool-call")).toBeTruthy();
    expect(screen.queryByTestId("tool-card")).toBeNull();
  });

  it("renders images carried by a tool result", () => {
    render(
      <Transcript
        items={[
          {
            kind: "tool",
            id: "call-1",
            tool: toolRun({
              resultText: "",
              result: {
                content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
              },
            }),
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByAltText("tool result")).toHaveAttribute(
      "src",
      "data:image/png;base64,aGVsbG8=",
    );
  });

  it("previews long output while the card is collapsed", () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    const { container } = render(
      <Transcript
        items={[
          {
            kind: "tool",
            id: "call-1",
            tool: toolRun({ resultText: lines }),
          },
        ]}
      />,
    );
    expect(container.textContent).toContain("line 1");
    expect(container.textContent).toContain("2 more lines");
  });
});
