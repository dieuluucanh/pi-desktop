import { describe, expect, it } from "vitest";
import {
  createTranscriptState,
  reduceSessionEvents,
} from "../../src/renderer/src/session/session-events";
import { fixtures, fullTurn } from "./fixtures/session-events";

describe("session-event fixtures", () => {
  it("are deterministic", () => {
    expect(JSON.stringify(fullTurn())).toBe(JSON.stringify(fullTurn()));
  });

  it("cover the assistant/tool/toolResult turn shape", () => {
    const events = fullTurn();
    expect(events.map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        "message_start",
        "message_end",
        "tool_execution_start",
        "tool_execution_end",
        "agent_end",
      ]),
    );
    expect(
      events.some(
        (entry) =>
          (entry.payload as { message?: { role?: string } }).message?.role === "toolResult",
      ),
    ).toBe(true);
  });

  it("drive the reducer without throwing", () => {
    const state = reduceSessionEvents(createTranscriptState(), fullTurn());
    expect(state.items.length).toBeGreaterThan(0);
    expect(state.items.some((item) => item.kind === "tool")).toBe(true);
    expect(
      state.items.some((item) => item.kind === "message" && item.message.role === "assistant"),
    ).toBe(true);
  });

  it("build small event groups", () => {
    expect(fixtures.text("m", "hi").at(-1)?.event).toBe("message_end");
    expect(fixtures.retryStart(2, 3, 500).payload).toMatchObject({ attempt: 2, delayMs: 500 });
    expect(fixtures.toolResult("c", "read", [{ type: "text", text: "x" }])).toHaveLength(2);
  });
});
