import { describe, expect, it } from "vitest";
import {
  compileFindPattern,
  findInTranscript,
  searchableTextOf,
  splitByPattern,
  stepMatchIndex,
} from "../../src/renderer/src/session/transcript-search";
import {
  createTranscriptState,
  reduceSessionEvents,
  type TranscriptItem,
} from "../../src/renderer/src/session/session-events";
import { fixtures } from "./fixtures/session-events";

/**
 * The transcript matcher (2026-10-26 session-parity plan step 11). Pure, so it
 * can be exercised on a big fixture without a DOM.
 */

function turnItems(): TranscriptItem[] {
  return reduceSessionEvents(createTranscriptState(), [
    fixtures.messageStart(
      { role: "user", content: [{ type: "text", text: "find the gizmo" }] },
      "u1",
    ),
    fixtures.messageEnd(
      { role: "user", content: [{ type: "text", text: "find the gizmo" }] },
      "u1",
    ),
    fixtures.messageStart({ role: "assistant" }, "a1"),
    fixtures.messageUpdate({ type: "thinking_start", contentIndex: 0 }),
    fixtures.messageUpdate({ type: "thinking_delta", contentIndex: 0, delta: "the gizmo is here" }),
    fixtures.messageUpdate({ type: "text_start", contentIndex: 1 }),
    fixtures.messageUpdate({ type: "text_delta", contentIndex: 1, delta: "GIZMO found" }),
    fixtures.messageEnd(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "the gizmo is here" },
          { type: "text", text: "GIZMO found" },
        ],
      },
      "a1",
    ),
    fixtures.toolStart("call-1", "read", { path: "gizmo.txt" }),
    fixtures.toolEnd("call-1", "read", { content: [{ type: "text", text: "gizmo body" }] }),
  ]).items;
}

describe("compileFindPattern", () => {
  it("is case-insensitive and escapes a literal query", () => {
    const { pattern } = compileFindPattern("a.b");
    expect(pattern?.test("A.B")).toBe(true);
    expect(pattern?.test("aXb")).toBe(false);
  });

  it("surfaces an invalid regular expression instead of finding nothing", () => {
    const result = compileFindPattern("a(", true);
    expect(result.pattern).toBeNull();
    expect(result.error).toMatch(/group|parenth|unterminated/i);
  });

  it("matches a regex when asked", () => {
    const { pattern } = compileFindPattern("giz+mo", true);
    expect(pattern?.test("gizzmo")).toBe(true);
  });
});

describe("splitByPattern", () => {
  it("splits matched and plain runs", () => {
    const { pattern } = compileFindPattern("gizmo");
    expect(splitByPattern("a gizmo b", pattern!)).toEqual([
      { text: "a ", match: false },
      { text: "gizmo", match: true },
      { text: " b", match: false },
    ]);
  });

  it("never loops on a zero-width pattern", () => {
    const { pattern } = compileFindPattern("x*", true);
    expect(() => splitByPattern("abc", pattern!)).not.toThrow();
  });
});

describe("findInTranscript", () => {
  it("searches text, thinking, tool args and tool results", () => {
    const result = findInTranscript(turnItems(), "gizmo");
    // user text, thinking, assistant text, tool arg path, tool result body.
    expect(result.matches.length).toBeGreaterThanOrEqual(5);
    expect(result.matches[0]?.itemId).toBe("u1");
  });

  it("reports one match per occurrence with an excerpt", () => {
    const result = findInTranscript(turnItems(), "found");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.excerpt).toContain("GIZMO found");
  });

  it("caps the results", () => {
    const result = findInTranscript(turnItems(), "gizmo", { limit: 2 });
    expect(result.matches).toHaveLength(2);
  });

  it("returns the pattern for highlighting and no matches for an empty query", () => {
    const empty = findInTranscript(turnItems(), "");
    expect(empty.pattern).toBeNull();
    expect(empty.matches).toEqual([]);
    const found = findInTranscript(turnItems(), "gizmo");
    expect(found.pattern).toBeInstanceOf(RegExp);
  });

  it("searches notices", () => {
    const items = reduceSessionEvents(createTranscriptState(), [
      fixtures.compactionStart(),
      fixtures.compactionEnd("summary text", { aborted: true }),
    ]).items;
    const result = findInTranscript(items, "cancelled");
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("reads a tool's args and result as searchable text", () => {
    const items = turnItems();
    const tool = items.find((item) => item.kind === "tool");
    expect(tool && searchableTextOf(tool)).toMatch(/gizmo\.txt/);
  });
});

describe("stepMatchIndex", () => {
  it("wraps in both directions and starts at the first match", () => {
    expect(stepMatchIndex(-1, 3, 1)).toBe(0);
    expect(stepMatchIndex(-1, 3, -1)).toBe(2);
    expect(stepMatchIndex(2, 3, 1)).toBe(0);
    expect(stepMatchIndex(0, 3, -1)).toBe(2);
    expect(stepMatchIndex(0, 0, 1)).toBe(-1);
  });
});

describe("collapsed command prompts (2026-10-26 composer plan)", () => {
  it("searches the origin but not the hidden expanded body", () => {
    const items = reduceSessionEvents(createTranscriptState(), [
      {
        event: "message_start",
        payload: {
          message: { role: "user", content: [{ type: "text", text: "secret expanded body" }] },
          promptOrigin: "/commit -a",
        },
      },
    ]).items;
    const collapsed = new Set(items.map((item) => item.id));

    expect(findInTranscript(items, "secret").matches).toHaveLength(1);
    expect(
      findInTranscript(items, "secret", { collapsedPromptIds: collapsed }).matches,
    ).toHaveLength(0);
    expect(
      findInTranscript(items, "/commit", { collapsedPromptIds: collapsed }).matches,
    ).toHaveLength(1);
  });
});
