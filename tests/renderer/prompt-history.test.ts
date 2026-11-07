import { describe, expect, it } from "vitest";

import {
  MAX_PROMPT_HISTORY,
  mergePromptHistory,
  promptHistoryFromTranscript,
  promptHistoryText,
  stepPromptHistory,
  type PromptHistoryBrowse,
  type PromptHistoryMessage,
} from "../../src/renderer/src/session/prompt-history";

/**
 * Prompt history (2026-11-07 plan).
 *
 * These cases pin the two defects that lost a pending prompt: the walk must
 * return to the exact draft (including an empty one), and the result must
 * distinguish "nothing happened" from "the live draft was restored". The
 * reference behaviour is terminal Pi's `navigateHistory`
 * (`pi-tui/dist/components/editor.js:333-368`).
 */

const ENTRIES = ["newest prompt", "older prompt"];

function browse(overrides: Partial<PromptHistoryBrowse> = {}): PromptHistoryBrowse {
  return { index: 0, draftText: "pending draft", draftCaret: 13, ...overrides };
}

describe("entering history", () => {
  it("recalls the newest prompt and stashes the draft", () => {
    expect(
      stepPromptHistory({
        direction: -1,
        entries: ENTRIES,
        browse: undefined,
        draft: "pending draft",
        caret: 4,
      }),
    ).toEqual({
      kind: "applied",
      text: "newest prompt",
      caret: "newest prompt".length,
      browse: { index: 0, draftText: "pending draft", draftCaret: 4 },
    });
  });

  it("stashes an empty draft too", () => {
    expect(
      stepPromptHistory({
        direction: -1,
        entries: ENTRIES,
        browse: undefined,
        draft: "",
        caret: 0,
      }),
    ).toEqual({
      kind: "applied",
      text: "newest prompt",
      caret: "newest prompt".length,
      browse: { index: 0, draftText: "", draftCaret: 0 },
    });
  });

  it("clamps a caret outside the draft", () => {
    const step = stepPromptHistory({
      direction: -1,
      entries: ENTRIES,
      browse: undefined,
      draft: "hi",
      caret: 99,
    });
    expect(step.kind === "applied" ? step.browse : null).toEqual({
      index: 0,
      draftText: "hi",
      draftCaret: 2,
    });
  });

  it("does nothing when no prompt was sent", () => {
    expect(
      stepPromptHistory({ direction: -1, entries: [], browse: undefined, draft: "x", caret: 0 }),
    ).toEqual({ kind: "none" });
  });
});

describe("walking the history", () => {
  it("walks back through older entries, caret at the end", () => {
    expect(
      stepPromptHistory({
        direction: -1,
        entries: ENTRIES,
        browse: browse(),
        draft: "newest prompt",
        caret: 0,
      }),
    ).toEqual({
      kind: "applied",
      text: "older prompt",
      caret: "older prompt".length,
      browse: browse({ index: 1 }),
    });
  });

  it("stops at the oldest entry without wrapping", () => {
    expect(
      stepPromptHistory({
        direction: -1,
        entries: ENTRIES,
        browse: browse({ index: ENTRIES.length - 1 }),
        draft: "older prompt",
        caret: 0,
      }),
    ).toEqual({ kind: "none" });
  });

  it("walks forward within history", () => {
    expect(
      stepPromptHistory({
        direction: 1,
        entries: ENTRIES,
        browse: browse({ index: 1 }),
        draft: "older prompt",
        caret: 0,
      }),
    ).toEqual({
      kind: "applied",
      text: "newest prompt",
      caret: "newest prompt".length,
      browse: browse({ index: 0 }),
    });
  });

  it("leaves history alone when Down is pressed outside it", () => {
    expect(
      stepPromptHistory({
        direction: 1,
        entries: ENTRIES,
        browse: undefined,
        draft: "typed",
        caret: 5,
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("returning to the draft", () => {
  it("restores the exact text and caret", () => {
    expect(
      stepPromptHistory({
        direction: 1,
        entries: ENTRIES,
        browse: browse({ draftText: "pending draft", draftCaret: 7 }),
        draft: "newest prompt",
        caret: 0,
      }),
    ).toEqual({
      kind: "applied",
      text: "pending draft",
      caret: 7,
      browse: null,
    });
  });

  it("returns an empty draft as an applied step, not none", () => {
    // The regression: returning `none` here let the recalled text stay on
    // screen, because the composer only clears the buffer for a non-none step.
    expect(
      stepPromptHistory({
        direction: 1,
        entries: ENTRIES,
        browse: browse({ draftText: "", draftCaret: 0 }),
        draft: "newest prompt",
        caret: 0,
      }),
    ).toEqual({ kind: "applied", text: "", caret: 0, browse: null });
  });

  it("clamps a stale draft caret to the restored text", () => {
    const step = stepPromptHistory({
      direction: 1,
      entries: ENTRIES,
      browse: browse({ draftText: "hi", draftCaret: 50 }),
      draft: "newest prompt",
      caret: 0,
    });
    expect(step.kind === "applied" ? step.caret : null).toBe(2);
  });
});

describe("defensive state", () => {
  it("clamps a stale index instead of reading undefined", () => {
    expect(
      stepPromptHistory({
        direction: -1,
        entries: ENTRIES,
        browse: browse({ index: 99 }),
        draft: "newest prompt",
        caret: 0,
      }),
    ).toEqual({ kind: "none" });
    expect(
      stepPromptHistory({
        direction: 1,
        entries: ENTRIES,
        browse: browse({ index: 99 }),
        draft: "newest prompt",
        caret: 0,
      }),
    ).toMatchObject({ kind: "applied", text: "newest prompt" });
  });

  it("treats a negative index as the newest entry", () => {
    expect(
      stepPromptHistory({
        direction: 1,
        entries: ENTRIES,
        browse: browse({ index: -5 }),
        draft: "pending draft",
        caret: 0,
      }),
    ).toEqual({
      kind: "applied",
      text: "pending draft",
      caret: 13,
      browse: null,
    });
  });

  it("keeps a hundred-entry cap constant for the store", () => {
    expect(MAX_PROMPT_HISTORY).toBe(100);
  });
});

function user(text: string, origin?: string): PromptHistoryMessage {
  return {
    role: "user",
    blocks: text.length > 0 ? [{ kind: "text", text }] : [],
    ...(origin ? { promptOrigin: origin } : {}),
  };
}

function imageOnly(): PromptHistoryMessage {
  return { role: "user", blocks: [{ kind: "image" }] };
}

describe("promptHistoryText", () => {
  it("prefers the typed command over the expanded body", () => {
    expect(promptHistoryText(user("expanded instruction", "/skill:review src"))).toBe(
      "/skill:review src",
    );
  });

  it("falls back to the body when there is no origin", () => {
    expect(promptHistoryText(user("  fix the bug  "))).toBe("fix the bug");
    expect(promptHistoryText(user("expanded body", "   "))).toBe("expanded body");
  });

  it("joins multiple text blocks the way the origin hash does", () => {
    expect(
      promptHistoryText({
        role: "user",
        blocks: [
          { kind: "text", text: "first line" },
          { kind: "image" },
          { kind: "text", text: "second line" },
        ],
      }),
    ).toBe("first line\nsecond line");
  });

  it("has no text for an image-only prompt", () => {
    expect(promptHistoryText(imageOnly())).toBeNull();
  });
});

describe("promptHistoryFromTranscript", () => {
  it("builds newest-first history from user messages", () => {
    expect(
      promptHistoryFromTranscript([
        user("first prompt"),
        { role: "assistant", blocks: [{ kind: "text", text: "answer" }] },
        user("second prompt"),
      ]),
    ).toEqual(["second prompt", "first prompt"]);
  });

  it("collapses only consecutive duplicates", () => {
    expect(promptHistoryFromTranscript([user("a"), user("a"), user("b")])).toEqual(["b", "a"]);
    expect(promptHistoryFromTranscript([user("a"), user("b"), user("a")])).toEqual(["a", "b", "a"]);
  });

  it("keeps the newest hundred entries", () => {
    const messages = Array.from({ length: 101 }, (_, index) => user(`prompt ${index}`));
    const history = promptHistoryFromTranscript(messages);
    expect(history).toHaveLength(100);
    expect(history[0]).toBe("prompt 100");
    expect(history.at(-1)).toBe("prompt 1");
    expect(history).not.toContain("prompt 0");
  });

  it("ignores every non-user role and image-only prompts", () => {
    expect(
      promptHistoryFromTranscript([
        user("typed"),
        imageOnly(),
        { role: "bashExecution", blocks: [{ kind: "text", text: "!pwd" }] },
        { role: "custom", blocks: [{ kind: "text", text: "extension context" }] },
        { role: "compaction", blocks: [{ kind: "text", text: "summary" }] },
        { role: "assistant", blocks: [{ kind: "text", text: "answer" }] },
      ]),
    ).toEqual(["typed"]);
  });

  it("uses the origin for a command prompt", () => {
    expect(
      promptHistoryFromTranscript([user("expanded instruction", "/skill:review src")]),
    ).toEqual(["/skill:review src"]);
  });
});

describe("mergePromptHistory", () => {
  it("puts the live prompts above the seed", () => {
    expect(mergePromptHistory(["this run"], ["from the session", "older"])).toEqual([
      "this run",
      "from the session",
      "older",
    ]);
  });

  it("does not show a prompt twice when it is in both lists", () => {
    expect(mergePromptHistory(["recent"], ["recent", "older"])).toEqual(["recent", "older"]);
  });

  it("preserves repeats that only exist inside the seed", () => {
    expect(mergePromptHistory(["live"], ["a", "b", "a"])).toEqual(["live", "a", "b", "a"]);
  });

  it("caps the result at a hundred entries", () => {
    const live = Array.from({ length: 99 }, (_, index) => `live ${index}`);
    const merged = mergePromptHistory(live, ["seed newest", "seed older"]);
    expect(merged).toHaveLength(100);
    expect(merged[99]).toBe("seed newest");
    expect(merged).not.toContain("seed older");
  });

  it("handles either side being empty", () => {
    expect(mergePromptHistory([], ["seed"])).toEqual(["seed"]);
    expect(mergePromptHistory(["live"], [])).toEqual(["live"]);
    expect(mergePromptHistory([], [])).toEqual([]);
  });
});
