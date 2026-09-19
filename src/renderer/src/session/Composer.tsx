import { useCallback, useRef, useState } from "react";
import { Paperclip, Send, Square, X } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { fileToAttachment, isImageFile, type ImageAttachment } from "./image-attachment";
import type { TranscriptQueue } from "./session-events";
import type { SendMode } from "../state/app-store";

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
  onSend: (text: string, images: ImageAttachment[]) => Promise<boolean>;
  onStop: () => void;
  onClearQueue: () => void;
  onSendModeChange: (mode: SendMode) => void;
  onHistoryStep: (direction: 1 | -1) => string | null;
  /** Step 7 attaches the completion overlay here. */
  completionSlot?: React.ReactNode;
}

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
  completionSlot,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const queued = [...queue.steering, ...queue.followUp];

  const submit = useCallback(async () => {
    if (!enabled || busy) return;
    if (draft.trim().length === 0 && attachments.length === 0) return;
    setBusy(true);
    try {
      const sent = await onSend(draft, attachments);
      if (sent) setAttachments([]);
    } finally {
      setBusy(false);
    }
  }, [attachments, busy, draft, enabled, onSend]);

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
          onChange={(event) => onDraftChange(event.target.value)}
          onPaste={(event) => {
            const files = [...(event.clipboardData?.files ?? [])];
            if (files.length > 0) void addFiles(files);
          }}
          onKeyDown={(event) => {
            // IME guard first: Enter during composition belongs to the input method.
            if (event.nativeEvent.isComposing) return;
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
