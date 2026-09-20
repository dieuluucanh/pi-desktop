import { useCallback, useEffect, useRef, useState } from "react";
import { Paperclip, Send, Square, X } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { fileToAttachment, isImageFile, type ImageAttachment } from "./image-attachment";
import type { TranscriptQueue } from "./session-events";
import type { SendMode } from "../state/app-store";
import { CompletionOverlay } from "../completion/CompletionOverlay";
import { joinBuffer, offsetToPosition, positionToOffset, splitBuffer } from "../completion/token";
import type {
  CompletionItem,
  CompletionProvider,
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
  contextLabel?: string | null;
  onDraftChange: (text: string) => void;
  onSend: (
    text: string,
    images: ImageAttachment[],
    options?: { preferredSource?: CompletionSource },
  ) => Promise<boolean>;
  onStop: () => void;
  onClearQueue: () => void;
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
  contextLabel,
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
  const [pickedSource, setPickedSource] = useState<CompletionSource | undefined>(undefined);
  const caretRef = useRef(0);
  const completionAbortRef = useRef<AbortController | null>(null);
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queued = [...queue.steering, ...queue.followUp];

  /** The buffer and caret as the provider contract wants them: lines + column. */
  const currentBuffer = useCallback(() => {
    const text = textareaRef.current?.value ?? draft;
    return { lines: splitBuffer(text), position: offsetToPosition(text, caretRef.current) };
  }, [draft]);

  const closeCompletion = useCallback(() => {
    setSuggestions(null);
    setActiveIndex(0);
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
    (item: CompletionItem) => {
      if (!completion || !suggestions) return;
      const { lines, position } = currentBuffer();
      const next = completion.provider.applyCompletion(
        lines,
        position.line,
        position.col,
        item,
        suggestions.prefix,
      );
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
      });
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

  const submit = useCallback(async () => {
    if (!enabled || busy) return;
    if (draft.trim().length === 0 && attachments.length === 0) return;
    setBusy(true);
    try {
      const sent = await onSend(draft, attachments, {
        ...(pickedSource ? { preferredSource: pickedSource } : {}),
      });
      if (sent) {
        setAttachments([]);
        setPickedSource(undefined);
        closeCompletion();
      }
    } finally {
      setBusy(false);
    }
  }, [attachments, busy, closeCompletion, draft, enabled, onSend, pickedSource]);

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
        "shrink-0 border-t border-line bg-surface px-3 py-2",
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
          className="max-h-48 min-h-16 flex-1 resize-y rounded-sm border border-line bg-sunken px-2 py-1.5 font-mono text-sm outline-none placeholder:text-ink-faint disabled:opacity-60"
          onChange={(event) => {
            caretRef.current = event.target.selectionStart;
            setPickedSource(undefined);
            onDraftChange(event.target.value);
            refreshCompletion(false);
          }}
          onSelect={(event) => {
            caretRef.current = event.currentTarget.selectionStart;
          }}
          onPaste={(event) => {
            const files = [...(event.clipboardData?.files ?? [])];
            if (files.length > 0) void addFiles(files);
          }}
          onKeyDown={(event) => {
            // IME guard first: Enter during composition belongs to the input method.
            if (event.nativeEvent.isComposing) return;

            // The completion menu owns these keys while it is open, so Enter
            // accepts a suggestion instead of sending half a command.
            const menu = suggestions;
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
                  applySuggestion(item);
                  return;
                }
              }
            } else if (event.key === "Tab" && completion) {
              // Tab on a path-shaped token asks explicitly (Pi's editor does too).
              event.preventDefault();
              refreshCompletion(true);
              return;
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
        <span>
          <span className="font-mono">/</span> commands
        </span>
        <span>
          <span className="font-mono">@</span> files
        </span>
        <span>
          <span className="font-mono">#</span> documents
        </span>
        <span>Enter sends · Shift+Enter newline{running ? " · Esc stops" : ""}</span>
        {contextLabel ? <span className="ml-auto">{contextLabel}</span> : null}
      </div>
    </div>
  );
}
