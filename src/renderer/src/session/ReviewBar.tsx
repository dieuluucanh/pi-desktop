import { Button } from "../ui/button";
import type { ReviewPhase } from "../../../shared/workflow-mode";

/**
 * The Review bar (2026-11-14 review-mode-isolation plan step 12).
 *
 * Review owns the turn from entry to decision, so the composer refuses prose
 * and mode switches (the store enforces that). Without this bar the only way to
 * move a review was to remember the slash commands, which made an isolated mode
 * feel like a hang. One row above the working row carries the three controls a
 * review actually has:
 *
 *  - `running`: Pause / Abort;
 *  - `paused`: Resume / Abort;
 *  - `handoff`: the reviewer has finished, so there is nothing to abort — open
 *    the review tab and approve or annotate there. `/review-abort` remains the
 *    command escape for skipping the handoff.
 *
 * The bar is presentational: `SessionView` owns the commands and the tab link.
 */

const PHASE_LABEL: Record<ReviewPhase, string> = {
  running: "Review owns the turn · modes locked",
  paused: "Review paused",
  handoff: "Awaiting your decision in the review tab",
};

export function ReviewBar({
  phase,
  canOpenReview,
  onPause,
  onResume,
  onAbort,
  onOpenReview,
}: {
  phase: ReviewPhase;
  /** True when the session has a linked loopback review tab to focus. */
  canOpenReview: boolean;
  onPause: () => void;
  onResume: () => void;
  onAbort: () => void;
  onOpenReview: () => void;
}) {
  return (
    <div
      data-testid="review-bar"
      data-phase={phase}
      role="status"
      className="flex shrink-0 items-center gap-2 border-t border-info/40 bg-info/5 px-3 py-1 text-xs"
    >
      <span className="font-medium text-info">Review</span>
      <span className="min-w-0 truncate text-ink-muted">{PHASE_LABEL[phase]}</span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
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
