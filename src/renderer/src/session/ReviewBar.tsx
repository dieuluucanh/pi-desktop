import { visibleWidth } from "../../../shared/ansi";
import { reviewLineText, statusLineText, type ReviewPhase } from "../../../shared/workflow-mode";
import { AnsiLine } from "../tui/AnsiBlock";
import { Button } from "../ui/button";

/**
 * The Review row (2026-11-14 review-mode-isolation plan step 12; merged into one
 * line by the 2026-11-18 review-status-line plan).
 *
 * Review owns the turn from entry to decision, so the composer refuses prose
 * and mode switches (the store enforces that). The row carries the extension's
 * live `workflow-review` line on the left — the same text terminal Pi paints —
 * and only the desktop controls on the right:
 *
 *  - `running`: Pause / Abort;
 *  - `paused`: Resume / Abort;
 *  - `handoff`: the reviewer has finished, so there is nothing to abort — open
 *    the review tab and approve or annotate there. `/review-abort` remains the
 *    command escape for skipping the handoff (and is named in the line).
 *
 * The row is presentational: `SessionView` owns the line source, the commands
 * and the tab link. It renders after the above-editor widget strips (the todo
 * panel) and before the composer, matching terminal Pi's placement.
 */

export function ReviewBar({
  phase,
  text,
  canOpenReview,
  onPause,
  onResume,
  onAbort,
  onOpenReview,
}: {
  phase: ReviewPhase;
  /** The extension's `workflow-review` line; a phase fallback is used if empty. */
  text: string;
  /** True when the session has a linked loopback review tab to focus. */
  canOpenReview: boolean;
  onPause: () => void;
  onResume: () => void;
  onAbort: () => void;
  onOpenReview: () => void;
}) {
  const line = statusLineText(text).length > 0 ? text : reviewLineText({ phase });
  return (
    <div
      data-testid="review-bar"
      data-phase={phase}
      role="status"
      className="flex shrink-0 items-center gap-2 border-t border-info/40 bg-info/5 px-3 py-1 text-xs"
    >
      <div className="min-w-0 flex-1 overflow-hidden" title={statusLineText(line)}>
        <AnsiLine line={line} width={visibleWidth(line)} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {phase === "running" ? (
          <Button size="sm" variant="secondary" onClick={onPause}>
            Pause
          </Button>
        ) : null}
        {phase === "paused" ? (
          <Button size="sm" variant="primary" onClick={onResume}>
            Resume
          </Button>
        ) : null}
        {phase === "handoff" && canOpenReview ? (
          <Button size="sm" variant="secondary" onClick={onOpenReview}>
            Open review tab
          </Button>
        ) : null}
        {phase !== "handoff" ? (
          <Button size="sm" variant="danger" onClick={onAbort}>
            Abort
          </Button>
        ) : null}
      </div>
    </div>
  );
}
