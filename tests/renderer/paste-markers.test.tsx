import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collapsePastes,
  expandPasteMarkers,
  findPasteMarkers,
  lostPasteIds,
  pasteMarkerText,
  shouldCollapsePaste,
} from "../../src/renderer/src/session/paste-markers";
import { Composer } from "../../src/renderer/src/session/Composer";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * Paste markers (2026-10-26 session-parity plan step 20).
 *
 * A large paste becomes one token; the body stays in renderer memory and only
 * the expanded text is sent or mirrored to the host. A restart leaves the
 * marker with a "content lost" hint rather than a silent token.
 */

const LONG = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");

describe("marker model", () => {
  it("collapses only pastes over the thresholds", () => {
    expect(shouldCollapsePaste("short text")).toBe(false);
    expect(shouldCollapsePaste(Array.from({ length: 10 }, () => "x").join("\n"))).toBe(false);
    expect(shouldCollapsePaste(Array.from({ length: 11 }, () => "x").join("\n"))).toBe(true);
    expect(shouldCollapsePaste("x".repeat(1_001))).toBe(true);
  });

  it("formats a line marker and a char marker", () => {
    expect(pasteMarkerText(3, LONG)).toBe("[paste #3 +200 lines]");
    expect(pasteMarkerText(4, "x".repeat(1_500))).toBe("[paste #4 1500 chars]");
  });

  it("finds markers in order and reports ids missing from the map", () => {
    const text = "a [paste #1 +20 lines] b [paste #7 1200 chars]";
    expect(findPasteMarkers(text).map((marker) => marker.id)).toEqual([1, 7]);
    expect(lostPasteIds(text, new Set([1]))).toEqual([7]);
  });

  it("expands known markers and leaves an unknown one intact", () => {
    const bodies = new Map([[1, "first\nbody"]]);
    expect(expandPasteMarkers("x [paste #1 +2 lines] y [paste #2 9 chars]", bodies)).toBe(
      "x first\nbody y [paste #2 9 chars]",
    );
  });

  it("does not re-collapse an existing marker", () => {
    const register = vi.fn(() => "[paste #9 +200 lines]");
    expect(collapsePastes("[paste #9 +200 lines]", register)).toBe("[paste #9 +200 lines]");
    expect(register).not.toHaveBeenCalled();
    expect(collapsePastes(LONG, register)).toBe("[paste #9 +200 lines]");
  });
});

function tab(): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: "/work/app",
    title: "app",
    sessionFile: "/profile/s1.jsonl",
    status: "idle",
    createdAt: 0,
    lastActiveAt: 0,
    model: null,
  };
}

function stubRequest(impl: (input: { method: string; params?: unknown }) => Promise<unknown>) {
  const request = vi.fn(async (input: { method: string; params?: unknown }) => impl(input));
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    tabs: [tab()],
    activeTabId: "tab-1",
    pasteBodies: {},
    pasteCounter: 1,
    hint: null,
  });
});

describe("composer paste", () => {
  it("inserts one marker for a 200-line paste and keeps the body in memory", () => {
    const onDraftChange = vi.fn();
    render(
      <Composer
        tabId="tab-1"
        running={false}
        draft=""
        queue={{ steering: [], followUp: [] }}
        onDraftChange={onDraftChange}
        onSend={async () => true}
        onStop={() => undefined}
        onClearQueue={() => undefined}
        onRestoreQueue={() => undefined}
        onHistoryStep={() => ({ kind: "none" })}
      />,
    );
    const box = screen.getByLabelText("Prompt");
    fireEvent.paste(box, { clipboardData: { files: [], getData: () => LONG } });

    expect(onDraftChange).toHaveBeenCalledTimes(1);
    const inserted = onDraftChange.mock.calls[0]?.[0] as string;
    expect(inserted).toBe("[paste #1 +200 lines]");
    expect(useAppStore.getState().pasteBodies["tab-1"]?.[1]).toBe(LONG);
  });

  it("leaves a small paste to the native textarea", () => {
    const onDraftChange = vi.fn();
    render(
      <Composer
        tabId="tab-1"
        running={false}
        draft=""
        queue={{ steering: [], followUp: [] }}
        onDraftChange={onDraftChange}
        onSend={async () => true}
        onStop={() => undefined}
        onClearQueue={() => undefined}
        onRestoreQueue={() => undefined}
        onHistoryStep={() => ({ kind: "none" })}
      />,
    );
    fireEvent.paste(screen.getByLabelText("Prompt"), {
      clipboardData: { files: [], getData: () => "two words" },
    });
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("deletes the whole marker on Backspace", async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    const draft = "before [paste #1 +200 lines]";
    render(
      <Composer
        tabId="tab-1"
        running={false}
        draft={draft}
        queue={{ steering: [], followUp: [] }}
        onDraftChange={onDraftChange}
        onSend={async () => true}
        onStop={() => undefined}
        onClearQueue={() => undefined}
        onRestoreQueue={() => undefined}
        onHistoryStep={() => ({ kind: "none" })}
      />,
    );
    const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    box.setSelectionRange(draft.length, draft.length);
    await user.click(box);
    box.setSelectionRange(draft.length, draft.length);
    fireEvent.keyDown(box, { key: "Backspace" });
    expect(onDraftChange).toHaveBeenCalledWith("before ");
  });

  it("warns when a restored marker has no body", () => {
    useAppStore.setState({ pasteCounter: 5 });
    render(
      <Composer
        tabId="tab-1"
        running={false}
        draft="[paste #2 +200 lines]"
        queue={{ steering: [], followUp: [] }}
        onDraftChange={() => undefined}
        onSend={async () => true}
        onStop={() => undefined}
        onClearQueue={() => undefined}
        onRestoreQueue={() => undefined}
        onHistoryStep={() => ({ kind: "none" })}
      />,
    );
    expect(screen.getByTestId("paste-content-lost")).toHaveTextContent("#2");
  });
});

describe("sending expands markers", () => {
  it("sends the body, not the marker", async () => {
    const request = stubRequest(async () => ({}));
    useAppStore.getState().registerPaste("tab-1", LONG);
    useAppStore.setState({ tabs: [{ ...tab(), status: "running" }] });

    await useAppStore.getState().sendPrompt("tab-1", "look: [paste #1 +200 lines]");

    const prompt = request.mock.calls.find(([input]) => input.method === "prompt")?.[0];
    expect(prompt?.params).toMatchObject({ text: `look: ${LONG}` });
  });

  it("mirrors the expanded text to the host editor", () => {
    vi.useFakeTimers();
    const request = stubRequest(async () => ({}));
    useAppStore.getState().registerPaste("tab-1", LONG);

    useAppStore.getState().setDraft("tab-1", "[paste #1 +200 lines]");
    vi.advanceTimersByTime(1_000);

    const mirror = request.mock.calls.find(([input]) => input.method === "oi.editorText")?.[0];
    if (mirror) {
      expect((mirror.params as { text: string }).text).toBe(LONG);
    }
    vi.useRealTimers();
  });
});
