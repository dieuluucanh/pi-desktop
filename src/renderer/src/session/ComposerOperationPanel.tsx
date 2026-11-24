import { useState } from "react";
import { AlertTriangle, Copy, RefreshCw, X } from "lucide-react";
import type { ComposerOperationDerived } from "../../../shared/composer-operation";
import { Button } from "../ui/button";
import { copyText } from "../ui/clipboard";
import { cn } from "../ui/cn";

/**
 * Generic composer-operation surface (2026-11-22 prompt-refinement plan, row 22).
 *
 * One compact strip above the composer shows a live draft transformation and
 * its recoverable result. It is deliberately separate from the transcript and
 * from the run status: a refinement never marks the conversation as running,
 * never appends synthetic user/assistant turns, and never borrows Review's
 * progress surface.
 *
 *   - The stage line comes from the operation's typed progress (`phase` plus
 *     the publisher's bounded message, which carries the effective model), so
 *     nothing here parses a label, glyph or extension name.
 *   - Cancel sends the typed cancel through the store; a second click is
 *     consumed while the first request is in flight.
 *   - A candidate that could not be applied automatically stays viewable and
 *     copyable, with the captured original beside it and an explicit replace
 *     affordance. Nothing silently overwrites newer typing.
 *   - The strip is mounted only in the composer branch of the session view, so
 *     a questionnaire/TUI dialog replaces it instead of nesting two surfaces.
 */

export interface ComposerOperationPanelProps {
  operation: ComposerOperationDerived;
  /** Cancels the live operation (`composer.cancel`). */
  onCancel: () => void;
  /** Replaces the current draft with the kept candidate, on explicit request. */
  onReplace: () => void;
  className?: string;
}

export function ComposerOperationPanel({
  operation,
  onCancel,
  onReplace,
  className,
}: ComposerOperationPanelProps) {
  const [view, setView] = useState<"none" | "result" | "original">("none");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const candidateText = operation.candidateText;
  const live = operation.isRunning || operation.isAwaitingInput;
  const hasResult = candidateText !== null && candidateText.length > 0;
  if (!live && !hasResult) return null;

  const stageLine =
    operation.statusMessage ??
    (operation.isAwaitingInput
      ? "Waiting for your answer — the draft is unchanged."
      : "Refining the prompt — nothing is sent or run.");

  const copy = async (text: string): Promise<void> => {
    const ok = await copyText(text);
    setCopyState(ok ? "copied" : "failed");
  };

  return (
    <div
      data-testid="composer-operation-panel"
      data-stage={operation.stage ?? ""}
      data-live={live ? "true" : "false"}
      data-has-result={hasResult ? "true" : "false"}
      className={cn(
        "mx-3 mb-1 shrink-0 rounded-md border border-line bg-surface-raised px-3 py-2 text-xs",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <RefreshCw
          className={cn("mt-0.5 size-3.5 shrink-0", live ? "animate-spin" : "text-ink-muted")}
          aria-hidden
        />
        <p
          data-testid="composer-operation-status"
          role="status"
          aria-live="polite"
          className="min-w-0 flex-1 break-words text-ink-muted"
        >
          {stageLine}
        </p>
        {live ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="composer-operation-cancel"
            aria-label="Cancel the prompt refinement"
            onClick={onCancel}
          >
            <X className="size-3.5" aria-hidden />
            Cancel
          </Button>
        ) : null}
      </div>

      {operation.isConflict && operation.conflict ? (
        <p
          data-testid="composer-operation-conflict"
          className="mt-1 flex items-start gap-1.5 text-amber-600"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{operation.conflict.message}</span>
        </p>
      ) : null}

      {hasResult ? (
        <div className="mt-2 space-y-1.5">
          {operation.candidateSummary ? (
            <p data-testid="composer-operation-summary" className="text-ink-muted">
              {operation.candidateSummary}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              data-testid="composer-operation-view-result"
              aria-pressed={view === "result"}
              onClick={() => setView((current) => (current === "result" ? "none" : "result"))}
            >
              {view === "result" ? "Hide refined prompt" : "View refined prompt"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="composer-operation-copy"
              onClick={() => void copy(candidateText)}
            >
              <Copy className="size-3.5" aria-hidden />
              Copy
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="composer-operation-view-original"
              aria-pressed={view === "original"}
              disabled={operation.originalText === null}
              onClick={() => setView((current) => (current === "original" ? "none" : "original"))}
            >
              {view === "original" ? "Hide original" : "View original prompt"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="composer-operation-replace"
              onClick={onReplace}
            >
              Replace my draft
            </Button>
            {copyState !== "idle" ? (
              <span data-testid="composer-operation-copy-state" className="text-ink-muted">
                {copyState === "copied" ? "Copied" : "Copy failed — select the text instead"}
              </span>
            ) : null}
          </div>
          {view === "result" ? (
            <textarea
              data-testid="composer-operation-candidate"
              readOnly
              aria-label="Refined prompt"
              className="max-h-48 min-h-20 w-full resize-y rounded border border-line bg-surface px-2 py-1 font-mono text-xs text-ink"
              value={candidateText}
            />
          ) : null}
          {view === "original" && operation.originalText !== null ? (
            <textarea
              data-testid="composer-operation-original"
              readOnly
              aria-label="Original prompt"
              className="max-h-48 min-h-20 w-full resize-y rounded border border-line bg-surface px-2 py-1 font-mono text-xs text-ink"
              value={operation.originalText}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
