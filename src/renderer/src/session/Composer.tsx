import { useCallback, useEffect, useRef, useState } from "react";
import { Paperclip, Send, Square, X } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { fileToAttachment, isImageFile, type ImageAttachment } from "./image-attachment";
import {
  parseWorkflowStatus,
  statusLineText,
  workflowBorderClass,
  workflowModeLabel,
  type WorkflowModeView,
} from "../../../shared/workflow-mode";
import type { TranscriptQueue } from "./session-events";
import type { SendMode } from "../state/app-store";
import { CompletionOverlay } from "../completion/CompletionOverlay";
import { matchShortcut } from "../shortcuts/dom-keys";
import { joinBuffer, offsetToPosition, positionToOffset, splitBuffer } from "../completion/token";
import { caretLabel, caretPosition, type CaretPosition } from "./caret";
import type {
  CompletionItem,
  CompletionProvider,
  CompletionResult,
  CompletionSource,
  CompletionSuggestions,
} from "../completion/types";

/**
 * The composer (plan step 6).
 *
 * A plain-text textarea over a text buffer — decision D-A5 — because Pi's
 * completion providers (step 7, and extension providers in step 16) work on
 * lines and a cursor column, not on rich content.
 *
 * Behaviours that matter and are easy to get wrong:
 *  - **IME safety**: Enter during composition confirms candidates, it must never
 *    send. Both `isComposing` and the legacy `keyCode === 229` are checked.
 *  - **Streaming delivery**: while the agent runs, a message must be marked
 *    `steer` or `followUp` (the host refuses it otherwise, exactly like RPC), so
 *    the composer makes the choice explicit and remembers it per session.
 *  - **Escape**: stop the run and put the queued text back in the editor.
 */

export interface ComposerProps {
  tabId: string;
  running: boolean;
  /** False when the session cannot accept prompts (failed/stopped). */
  enabled?: boolean;
  draft: string;
  queue: TranscriptQueue;
  sendMode: SendMode;
  onDraftChange: (text: string) => void;
  onSend: (
    text: string,
    images: ImageAttachment[],
    options?: { preferredSource?: CompletionSource },
  ) => Promise<boolean>;
  onStop: () => void;
  onClearQueue: () => void;
  /** The `workflow` extension status, decoded into a composer border colour. */
  workflowStatus?: string | null;
  /**
   * The session's registered extension shortcuts, used to give Tab to the mode
   * cycle (the workflow extension registers `tab`). Empty until the store loads
   * them, which the composer requests through `onRequestShortcuts`.
   */
  extensionShortcuts?: readonly { key: string }[];
  /** Runs one extension shortcut through `shortcuts.invoke`. */
  onInvokeShortcut?: (key: string) => void;
  /** Asks the store to load the extension shortcuts (once). */
  onRequestShortcuts?: () => void;
  onSendModeChange: (mode: SendMode) => void;
  onHistoryStep: (direction: 1 | -1) => string | null;
  /** The completion engine (plan step 7); omit it to disable completion. */
  completion?: ComposerCompletion;
  /** Step 7 attaches the completion overlay here. */
  completionSlot?: React.ReactNode;
}

/** What the composer needs from the completion engine (plan step 7). */
export interface ComposerCompletion {
  provider: CompletionProvider;
  /**
   * Applies an accepted item. Used when the item came from a host-run extension
   * chain (plan step 16), whose own `applyCompletion` cannot run in the
   * renderer; returns null to fall back to `provider.applyCompletion`.
   */
  apply?: (
    item: CompletionItem,
    suggestions: CompletionSuggestions,
    buffer: { lines: string[]; line: number; col: number },
  ) => Promise<CompletionResult | null>;
}

/** Long enough to coalesce a burst of keystrokes, short enough to feel live. */
const COMPLETION_DEBOUNCE_MS = 60;

/**
 * Enter sends; Shift+Enter (and Alt+Enter) insert a newline.
 *
 * The IME guard uses `isComposing` only: the app ships one Chromium (Electron),
 * which sets it for every composition, so the legacy `keyCode === 229` fallback
 * (and its deprecated React field) is not needed.
 */
export function isSendKey(event: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}): boolean {
  if (event.isComposing === true) return false;
  return event.key === "Enter" && !event.shiftKey && !event.altKey;
}

function QueueChips({ queue, onClear }: { queue: TranscriptQueue; onClear: () => void }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5" data-testid="queue-chips">
      {queue.steering.map((text, index) => (
        <Badge key={`steer-${index}`} tone="accent" title={text}>
          steer · {text.slice(0, 40)}
        </Badge>
      ))}
      {queue.followUp.map((text, index) => (
        <Badge key={`follow-${index}`} tone="neutral" title={text}>
          follow-up · {text.slice(0, 40)}
        </Badge>
      ))}
      <button type="button" className="text-[11px] text-ink-faint hover:text-ink" onClick={onClear}>
        clear queue
      </button>
    </div>
  );
}

function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: readonly ImageAttachment[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="mb-2 flex flex-wrap gap-2" data-testid="attachments">
      {attachments.map((attachment) => (
        <span
          key={attachment.id}
          className="flex items-center gap-1.5 rounded-sm border border-line bg-raised px-2 py-1 text-[11px]"
        >
          <img
            alt={attachment.name}
            className="size-6 rounded-xs object-cover"
            src={`data:${attachment.mimeType};base64,${attachment.data}`}
          />
          {attachment.name}
          <button
            type="button"
            aria-label={`Remove ${attachment.name}`}
            onClick={() => onRemove(attachment.id)}
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
    </div>
  );
}

export function Composer({
  running,
  enabled = true,
  draft,
  queue,
  sendMode,
  workflowStatus,
  extensionShortcuts,
  onInvokeShortcut,
  onRequestShortcuts,
  onDraftChange,
  onSend,
  onStop,
  onClearQueue,
  onSendModeChange,
  onHistoryStep,
  completion,
  completionSlot,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<CompletionSuggestions | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // The source of the item the user picked, when a name was ambiguous. It is
  // cleared as soon as they type, so it only ever describes the current token.
  const [pickedSource, setPickedSource] = useState<CompletionSource | undefined>();
  const caretRef = useRef(0);
  // The caret's line/column, shown in the status row (plan step 1). The browser's
  // own caret is a thin blinking line that is easy to lose in a long buffer; the
  // readout is the explicit, always-readable position.
  const [caret, setCaret] = useState<CaretPosition>({ line: 1, column: 1 });
  const completionAbortRef = useRef<AbortController | null>(null);
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queued = [...queue.steering, ...queue.followUp];

  // The workflow extension reports its mode only through `ctx.ui.setStatus`, so
  // the composer decodes that text into a border colour and a badge label.
  // An unknown value degrades to the neutral border and no badge.
  const workflowMode: WorkflowModeView | null = parseWorkflowStatus(workflowStatus);
  const workflowLabel = workflowModeLabel(workflowMode);
  // Empty until the store loads the session's shortcuts (the composer asks via
  // `onRequestShortcuts` on the first Tab); an unknown list means Tab keeps its
  // completion behaviour rather than swallowing the key.
  const shortcuts = extensionShortcuts ?? [];

  /** The buffer and caret as the provider contract wants them: lines + column. */
  const currentBuffer = useCallback(() => {
    const text = textareaRef.current?.value ?? draft;
    return { lines: splitBuffer(text), position: offsetToPosition(text, caretRef.current) };
  }, [draft]);

  const closeCompletion = useCallback(() => {
    setSuggestions(null);
    setActiveIndex(0);
  }, []);

  /**
   * Mirrors the DOM caret into the completion engine (`caretRef`) and into the
   * readout. One source of truth: the offset the providers see is the offset
   * the user sees.
   */
  const syncCaret = useCallback((node: HTMLTextAreaElement | null) => {
    if (!node) return;
    const offset = node.selectionStart ?? 0;
    caretRef.current = offset;
    const next = caretPosition(node.value, offset);
    setCaret((previous) =>
      previous.line === next.line && previous.column === next.column ? previous : next,
    );
  }, []);

  const refreshCompletion = useCallback(
    (force: boolean) => {
      if (!completion) return;
      if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
      completionTimerRef.current = setTimeout(() => {
        completionTimerRef.current = null;
        completionAbortRef.current?.abort();
        const controller = new AbortController();
        completionAbortRef.current = controller;
        const { lines, position } = currentBuffer();
        void completion.provider
          .getSuggestions(lines, position.line, position.col, {
            signal: controller.signal,
            ...(force ? { force: true } : {}),
          })
          .then((result) => {
            if (controller.signal.aborted) return;
            if (!result || result.items.length === 0) {
              closeCompletion();
              return;
            }
            setSuggestions(result);
            setActiveIndex(0);
          })
          .catch(() => {
            if (!controller.signal.aborted) closeCompletion();
          });
      }, COMPLETION_DEBOUNCE_MS);
    },
    [closeCompletion, completion, currentBuffer],
  );

  const applySuggestion = useCallback(
    async (item: CompletionItem): Promise<{ text: string; source?: CompletionSource } | null> => {
      if (!completion || !suggestions) return null;
      const { lines, position } = currentBuffer();
      let next = completion.provider.applyCompletion(
        lines,
        position.line,
        position.col,
        item,
        suggestions.prefix,
      );
      if (completion.apply) {
        const remote = await completion.apply(item, suggestions, {
          lines,
          line: position.line,
          col: position.col,
        });
        if (remote) next = remote;
      }
      const text = joinBuffer(next.lines);
      const caret = positionToOffset(next.lines, { line: next.cursorLine, col: next.cursorCol });
      setPickedSource(item.source);
      closeCompletion();
      onDraftChange(text);
      // The caret has to move after React commits the new value, or the DOM
      // selection would be clamped to the old text length.
      queueMicrotask(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(caret, caret);
        caretRef.current = caret;
        setCaret(caretPosition(text, caret));
      });
      return { text, ...(item.source ? { source: item.source } : {}) };
    },
    [closeCompletion, completion, currentBuffer, onDraftChange, suggestions],
  );

  // A pending debounce or an in-flight request must not outlive the composer.
  useEffect(
    () => () => {
      if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
      completionAbortRef.current?.abort();
    },
    [],
  );

  // A draft that changed from outside the textarea (the history walk, a
  // restored draft) moves the caret too, so the readout is re-read once the
  // DOM carries the new value.
  useEffect(() => {
    const node = textareaRef.current;
    if (node && node.value === draft) syncCaret(node);
  }, [draft, syncCaret]);

  /**
   * Sends an explicit text and source. The Enter-on-completion path must not
   * read the `draft` prop or `pickedSource` state: both are stale while a
   * remote apply is awaited, and sending the old text would lose the fill.
   */
  const submitText = useCallback(
    async (text: string, source?: CompletionSource): Promise<boolean> => {
      if (!enabled || busy) return false;
      if (text.trim().length === 0 && attachments.length === 0) return false;
      setBusy(true);
      try {
        const sent = await onSend(text, attachments, {
          ...(source ? { preferredSource: source } : {}),
        });
        if (sent) {
          setAttachments([]);
          setPickedSource(undefined);
          closeCompletion();
        }
        return sent;
      } finally {
        setBusy(false);
      }
    },
    [attachments, busy, closeCompletion, enabled, onSend],
  );

  const submit = useCallback(async () => {
    await submitText(draft, pickedSource);
  }, [draft, pickedSource, submitText]);

  const addFiles = useCallback(async (files: readonly File[]) => {
    const images = files.filter((file) => isImageFile(file));
    if (images.length === 0) return;
    const added: ImageAttachment[] = [];
    for (const file of images) {
      const attachment = await fileToAttachment(file);
      if (attachment) added.push(attachment);
    }
    if (added.length > 0) setAttachments((current) => [...current, ...added]);
  }, []);

  return (
    <div
      className={cn(
        "relative shrink-0 border-t border-line bg-surface px-3 py-2",
        dragging && "ring-1 ring-accent",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void addFiles([...event.dataTransfer.files]);
      }}
    >
      {/* The mode badge rides the composer's top edge, the way Pi's editor shows
          its border label. It is the primary *textual* indicator of the active
          mode, so it renders at every width and is announced to assistive tech
          (`role="status"`) — colour alone must never be the only signal. The
          full extension status (profile/role/commit policy) stays reachable
          through `title`. */}
      {workflowLabel ? (
        <span
          data-testid="workflow-mode-badge"
          role="status"
          aria-live="polite"
          title={statusLineText(workflowStatus)}
          className="pointer-events-none absolute -top-2 right-3 rounded-xs border border-line bg-surface px-1.5 text-[10px] font-medium text-ink-muted"
        >
          {workflowLabel}
        </span>
      ) : null}

      {queued.length > 0 ? <QueueChips queue={queue} onClear={onClearQueue} /> : null}
      {attachments.length > 0 ? (
        <AttachmentChips
          attachments={attachments}
          onRemove={(id) => setAttachments((current) => current.filter((entry) => entry.id !== id))}
        />
      ) : null}

      {completionSlot}

      {suggestions && suggestions.items.length > 0 ? (
        <CompletionOverlay
          items={suggestions.items}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          onPick={applySuggestion}
        />
      ) : null}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          aria-label="Prompt"
          rows={2}
          value={draft}
          placeholder={
            enabled
              ? running
                ? `Type to steer the run (${sendMode === "steer" ? "steer" : "follow-up"})…`
                : "Ask Pi to change something…  / commands · @ files · # documents"
              : "This session is not running — start it above to send a prompt."
          }
          disabled={!enabled}
          className={cn(
            // The border tracks the workflow mode, mirroring Pi's editor border
            // (which tracks the thinking level). `border-line` is the neutral
            // default and the only class the placeholder set assumes.
            //
            // Focus is an *outer* ring (a box-shadow), never an outline: the
            // ring is painted outside the border, so the mode colour stays
            // readable while the composer is focused. This replaces the global
            // `:focus-visible` outline, which used to cover it in blue.
            "max-h-48 min-h-16 flex-1 resize-y rounded-sm border bg-sunken px-2 py-1.5 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-line-strong placeholder:text-ink-faint disabled:opacity-60",
            // The caret is the app's own accent colour, and a selection is
            // tinted with it, so the cursor is never lost in a dark buffer
            // (plan step 1).
            "caret-accent selection:bg-accent/25",
            workflowBorderClass(workflowMode),
          )}
          onChange={(event) => {
            syncCaret(event.target);
            setPickedSource(undefined);
            onDraftChange(event.target.value);
            refreshCompletion(false);
          }}
          onSelect={(event) => {
            syncCaret(event.currentTarget);
          }}
          onClick={(event) => {
            syncCaret(event.currentTarget);
          }}
          onKeyUp={(event) => {
            syncCaret(event.currentTarget);
          }}
          onPaste={(event) => {
            const files = [...(event.clipboardData?.files ?? [])];
            if (files.length > 0) void addFiles(files);
          }}
          onKeyDown={(event) => {
            // IME guard first: Enter during composition belongs to the input method.
            if (event.nativeEvent.isComposing) return;

            const menu = suggestions;
            const menuOpen = Boolean(menu && menu.items.length > 0);
            // The keys an open completion menu owns. Everything *else* still
            // reaches an extension shortcut, and a closed menu blocks nothing.
            const menuKey =
              menuOpen &&
              (event.key === "ArrowDown" ||
                event.key === "ArrowUp" ||
                event.key === "Escape" ||
                event.key === "Tab" ||
                event.key === "Enter");

            // Extension shortcuts come first, exactly as in Pi's editor
            // (`custom-editor.js:60` checks `onExtensionShortcut` before any
            // editor handling). This is what lets the workflow extension's `tab`
            // cycle the mode, and its `ctrl+alt+p` alias too. Matching against
            // the registered chord list is inherently safe for a text input: a
            // key only fires if the session actually registered it.
            if (!menuKey) {
              const matched = matchShortcut(
                {
                  key: event.key,
                  ctrlKey: event.ctrlKey,
                  altKey: event.altKey,
                  shiftKey: event.shiftKey,
                  metaKey: event.metaKey,
                },
                shortcuts,
              );
              if (matched && onInvokeShortcut) {
                event.preventDefault();
                onInvokeShortcut(matched);
                return;
              }
            }

            // The completion menu owns these keys while it is open, so Enter
            // accepts a suggestion instead of sending half a command.
            if (menu && menu.items.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) => Math.min(index + 1, menu.items.length - 1));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 1, 0));
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                closeCompletion();
                return;
              }
              if (event.key === "Tab" || event.key === "Enter") {
                const item = menu.items[activeIndex];
                if (item) {
                  event.preventDefault();
                  // Pi parity: Enter on a command-name completion applies it
                  // and submits in one keystroke. Argument completions apply
                  // only; the user keeps finishing the command line. Tab never
                  // submits.
                  if (event.key === "Enter" && menu.prefix.startsWith("/")) {
                    void (async () => {
                      const applied = await applySuggestion(item);
                      if (applied) await submitText(applied.text, applied.source);
                    })();
                  } else {
                    void applySuggestion(item);
                  }
                  return;
                }
              }
            } else if (event.key === "Tab") {
              // No extension shortcut claimed Tab and no menu is open: keep the
              // original completion behaviour. If the list has not been fetched
              // yet, ask for it so the *next* Tab can cycle the mode.
              if (shortcuts.length === 0) onRequestShortcuts?.();
              if (completion) {
                // Tab on a path-shaped token asks explicitly (Pi's editor does too).
                event.preventDefault();
                refreshCompletion(true);
                return;
              }
            }

            if (event.key === "Escape" && running) {
              event.preventDefault();
              onStop();
              return;
            }
            if (event.key === "ArrowUp" && event.currentTarget.value.trim().length === 0) {
              const previous = onHistoryStep(-1);
              if (previous !== null) {
                event.preventDefault();
                onDraftChange(previous);
              }
              return;
            }
            if (event.key === "ArrowDown") {
              const next = onHistoryStep(1);
              if (next !== null) {
                event.preventDefault();
                onDraftChange(next);
              }
              return;
            }
            if (
              isSendKey({
                key: event.key,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                isComposing: event.nativeEvent.isComposing,
              })
            ) {
              event.preventDefault();
              void submit();
            }
          }}
        />

        <div className="flex flex-col items-stretch gap-1">
          {running ? (
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={sendMode === "steer" ? "secondary" : "ghost"}
                aria-pressed={sendMode === "steer"}
                aria-label="steer mode"
                title="Deliver this message as a steer (interrupts the current turn)"
                onClick={() => onSendModeChange("steer")}
              >
                steer
              </Button>
              <Button
                size="sm"
                variant={sendMode === "followUp" ? "secondary" : "ghost"}
                aria-pressed={sendMode === "followUp"}
                aria-label="follow-up mode"
                title="Deliver this message once the agent stops"
                onClick={() => onSendModeChange("followUp")}
              >
                follow-up
              </Button>
            </div>
          ) : null}
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="primary"
              disabled={!enabled || busy}
              onClick={() => void submit()}
              title="Enter"
            >
              <Send className="size-3.5" aria-hidden />
              {running ? (sendMode === "steer" ? "Steer" : "Follow up") : "Send"}
            </Button>
            {running ? (
              <Button size="sm" variant="danger" onClick={onStop} title="Esc">
                <Square className="size-3.5" aria-hidden />
                Stop
              </Button>
            ) : null}
            <label className="flex cursor-pointer items-center px-1 text-ink-faint hover:text-ink">
              <Paperclip className="size-3.5" aria-hidden />
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => void addFiles([...(event.target.files ?? [])])}
              />
            </label>
          </div>
        </div>
      </div>

      <div className="mt-1 flex items-center gap-3 text-[11px] text-ink-faint">
        {/* The hints shrink and clip rather than pushing the readout off the
            row (plan step 6). */}
        <div className="flex min-w-0 shrink items-center gap-3 overflow-hidden">
          <span className="shrink-0">
            <span className="font-mono">/</span> commands
          </span>
          <span className="shrink-0">
            <span className="font-mono">@</span> files
          </span>
          <span className="shrink-0">
            <span className="font-mono">#</span> documents
          </span>
          <span className="shrink-0">
            Enter sends · Shift+Enter newline{running ? " · Esc stops" : ""}
          </span>
        </div>
        {/* Where the cursor is. The browser's caret is a thin blinking line that
            is easy to lose in a long buffer, so the position is also spelled
            out (plan step 1). */}
        <span
          data-testid="composer-caret"
          className="ml-auto shrink-0 tabular-nums"
          title="Cursor position"
        >
          {caretLabel(caret)}
        </span>
      </div>
    </div>
  );
}
