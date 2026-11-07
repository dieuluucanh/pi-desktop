/**
 * Prompt-history navigation (2026-11-07 plan).
 *
 * Terminal Pi's editor owns this state machine in
 * `@earendil-works/pi-tui/dist/components/editor.js:240-368`: it keeps the sent
 * prompts, a `historyIndex` (`-1` = the live draft) and a `historyDraft` clone
 * of the editor state taken when browsing starts. Walking back to `-1` restores
 * the clone; any edit or submit calls `exitHistoryBrowsing` and drops it.
 *
 * The desktop keeps the same model — the user chose terminal-Pi parity — but
 * the walk lives here as a pure function so it can be tested without zustand or
 * a DOM. The store owns the buffers; this module only says what a key press
 * should do. `entries` is newest-first: prompts sent in this renderer run, then
 * the session-derived seed below them (see `promptHistoryFromTranscript`).
 *
 * The one deliberate caret difference is documented on the recall branch: the
 * caret lands at the end of a recalled entry, not at its start. The composer
 * only leaves history from the last line, so pi-tui's start-of-entry caret
 * would make the first `ArrowDown` walk a multi-line entry instead of returning
 * to the draft.
 */

/** pi-tui keeps 100 entries (`editor.js:316-318`); the store caps with this. */
export const MAX_PROMPT_HISTORY = 100;

/** Where a tab is in its sent-prompt history. Absence means the live draft. */
export interface PromptHistoryBrowse {
  /** 0 = the newest entry. */
  index: number;
  /** The draft the user was typing when browsing started (pi's `historyDraft`). */
  draftText: string;
  /** The caret offset in that draft when browsing started. */
  draftCaret: number;
}

/**
 * `none` = let the textarea handle the key natively.
 * `applied` = write `text` and place the caret at `caret`.
 *   `browse: null` restores the live draft, which may be the empty string.
 */
export type PromptHistoryStep =
  | { kind: "none" }
  | { kind: "applied"; text: string; caret: number; browse: PromptHistoryBrowse | null };

export interface PromptHistoryInput {
  /** `-1` is ArrowUp (older), `1` is ArrowDown (newer). */
  direction: 1 | -1;
  /** Sent prompts, newest first. */
  entries: readonly string[];
  /** The current browsing record, or undefined when the live draft is shown. */
  browse: PromptHistoryBrowse | undefined;
  /** The draft currently shown (the live draft or the preview). */
  draft: string;
  /** The live caret offset, captured when browsing starts. */
  caret: number;
}

/** One key press's effect: no wrap, no Down outside history. */
export function stepPromptHistory(input: PromptHistoryInput): PromptHistoryStep {
  const { direction, entries, browse, draft, caret } = input;
  if (entries.length === 0) return { kind: "none" };

  if (!browse) {
    // Down outside history is native caret movement; up enters at the newest.
    if (direction === 1) return { kind: "none" };
    const text = entries[0] ?? "";
    return {
      kind: "applied",
      text,
      // End, not pi-tui's start: the composer leaves history from the last line,
      // so this keeps the return gesture a single ArrowDown on multi-line text.
      caret: text.length,
      browse: {
        index: 0,
        draftText: draft,
        draftCaret: clampCaret(caret, draft.length),
      },
    };
  }

  // Defensive: a stale index (history replaced behind a live record) must never
  // read `undefined`; `rememberDraft` clears the record, and tabs are pruned.
  const index = Math.min(Math.max(browse.index, 0), entries.length - 1);
  const next = index - direction;
  if (next >= entries.length) return { kind: "none" };
  if (next < 0) {
    return {
      kind: "applied",
      text: browse.draftText,
      caret: clampCaret(browse.draftCaret, browse.draftText.length),
      browse: null,
    };
  }

  const text = entries[next] ?? "";
  return {
    kind: "applied",
    text,
    caret: text.length,
    browse: { ...browse, index: next },
  };
}

/** A caret offset inside `length`, tolerating a stale or corrupt value. */
function clampCaret(caret: number, length: number): number {
  if (!Number.isFinite(caret)) return 0;
  return Math.min(Math.max(Math.trunc(caret), 0), length);
}

/**
 * The fields the transcript seed needs. `TranscriptMessage` satisfies this
 * structurally, so this module stays free of store/DOM imports.
 */
export interface PromptHistoryMessage {
  role: string;
  blocks: readonly { kind: string; text?: string }[];
  promptOrigin?: string;
}

/**
 * The text a sent prompt is recalled as: the typed command when the renderer
 * knew it (`promptOrigin`), otherwise the message body (terminal Pi's
 * `addToHistory(textContent)`).
 */
export function promptHistoryText(message: PromptHistoryMessage): string | null {
  const origin = message.promptOrigin?.trim();
  if (origin) return origin;
  const text = message.blocks
    .flatMap((block) =>
      block.kind === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * Rebuilds prompt history from a session's messages, newest first.
 *
 * Terminal Pi does the same on every resume: it renders the active branch and
 * calls `editor.addToHistory(textContent)` for each user message
 * (`interactive-mode.js:3264-3266`, `:3487-3493`). The rules are pi-tui's
 * (`editor.js:308-319`): user messages only, trim, skip consecutive duplicates,
 * cap at `MAX_PROMPT_HISTORY`.
 */
export function promptHistoryFromTranscript(messages: readonly PromptHistoryMessage[]): string[] {
  const history: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = promptHistoryText(message);
    if (text === null || history[0] === text) continue;
    history.unshift(text);
    if (history.length > MAX_PROMPT_HISTORY) history.pop();
  }
  return history;
}

/**
 * Prompts sent in this renderer run above the session-derived seed.
 *
 * The live list wins (it is the most recent work and may include a prompt the
 * host has not persisted yet); a seed entry equal to any live entry is skipped
 * so a prompt that appears in both is not shown twice. Repeats that only exist
 * inside the seed are preserved, matching pi-tui's consecutive-only dedupe.
 */
export function mergePromptHistory(live: readonly string[], seed: readonly string[]): string[] {
  const liveTexts = new Set(live);
  const merged = [...live];
  for (const text of seed) {
    if (liveTexts.has(text)) continue;
    merged.push(text);
    if (merged.length >= MAX_PROMPT_HISTORY) break;
  }
  return merged.slice(0, MAX_PROMPT_HISTORY);
}
