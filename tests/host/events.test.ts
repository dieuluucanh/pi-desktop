import { describe, expect, it } from "vitest";
import {
  FORWARDED_SESSION_EVENTS,
  eventToFrame,
  sessionSnapshot,
  summarizeModel,
  type SessionStateLike,
} from "../../src/host/events";

function fakeSession(overrides: Partial<SessionStateLike> = {}): SessionStateLike {
  return {
    sessionId: "session-1",
    sessionFile: "C:/profile/sessions/session-1.jsonl",
    sessionName: "Budget work",
    model: { id: "claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4" },
    thinkingLevel: "medium",
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    isRetrying: false,
    messages: [{}, {}, {}],
    pendingMessageCount: 0,
    getSteeringMessages: () => ["steer me"],
    getFollowUpMessages: () => [],
    getActiveToolNames: () => ["read", "bash"],
    getAllTools: () => [{}, {}, {}, {}],
    getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
    autoCompactionEnabled: true,
    ...overrides,
  };
}

describe("summarizeModel", () => {
  it("summarises a model", () => {
    expect(summarizeModel({ id: "m", provider: "p", name: "M" })).toEqual({
      id: "m",
      provider: "p",
      name: "M",
    });
  });

  it("fills in defaults and rejects unusable models", () => {
    expect(summarizeModel({ id: "m" })).toEqual({ id: "m", provider: "unknown", name: null });
    expect(summarizeModel(undefined)).toBeNull();
  });
});

describe("sessionSnapshot", () => {
  it("captures the state the app renders", () => {
    const snapshot = sessionSnapshot(fakeSession({ isStreaming: true, isIdle: false }), "C:/work");

    expect(snapshot).toMatchObject({
      sessionId: "session-1",
      sessionName: "Budget work",
      cwd: "C:/work",
      thinkingLevel: "medium",
      streaming: true,
      idle: false,
      messageCount: 3,
      toolCount: 4,
      activeTools: ["read", "bash"],
      thinkingLevels: ["off", "low", "medium", "high"],
      steering: ["steer me"],
      autoCompaction: true,
    });
    expect(snapshot.model?.id).toBe("claude-sonnet-4");
  });

  it("survives a session whose accessors throw", () => {
    const session = fakeSession({
      getAllTools: () => {
        throw new Error("gone");
      },
      messages: undefined,
    });

    const snapshot = sessionSnapshot(session, "C:/work");

    expect(snapshot.toolCount).toBe(0);
    expect(snapshot.messageCount).toBe(0);
  });

  it("reports an empty snapshot for a missing session", () => {
    const snapshot = sessionSnapshot({}, "C:/work");

    expect(snapshot).toMatchObject({ sessionId: null, messageCount: 0, model: null, idle: true });
  });
});

describe("eventToFrame", () => {
  it("uses the event type as the frame name and the rest as the payload", () => {
    expect(eventToFrame({ type: "message_update", text: "hi", partial: true })).toEqual({
      event: "message_update",
      payload: { text: "hi", partial: true },
    });
  });

  it("keeps an empty payload for type-only events", () => {
    expect(eventToFrame({ type: "agent_start" })).toEqual({ event: "agent_start", payload: {} });
  });

  it("declares the events the app mirrors", () => {
    expect(FORWARDED_SESSION_EVENTS).toContain("agent_end");
    expect(FORWARDED_SESSION_EVENTS).toContain("tool_execution_end");
    expect(FORWARDED_SESSION_EVENTS).toContain("queue_update");
  });
});
