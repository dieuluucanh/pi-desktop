import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import type { TranscriptRunStatus } from "./session-events";

/**
 * The run-status row (2026-10-26 session-parity plan step 8).
 *
 * Terminal Pi shows a countdown plus a cancel hint for retries, compaction and
 * branch-summary retries (`status-indicator.js`). The desktop previously had an
 * end card only, so a rate-limited or long compaction looked like a hang.
 *
 * The countdown is derived from the event's absolute deadline (`until`) rather
 * than a local counter, so a state frame arriving mid-way shows the true
 * remaining time.
 */

function remainingSeconds(until: number | undefined, now: number): number | null {
  if (until === undefined) return null;
  return Math.max(0, Math.ceil((until - now) / 1000));
}

function runStatusLabel(status: TranscriptRunStatus, now: number): string {
  switch (status.kind) {
    case "compacting":
      return "Compacting the conversation…";
    case "retrying": {
      const seconds = remainingSeconds(status.until, now);
      const wait = seconds === null ? "" : ` in ${seconds}s`;
      return `Retrying (${status.attempt}/${status.maxAttempts})${wait}…`;
    }
    case "summarizing": {
      const seconds = remainingSeconds(status.until, now);
      const wait = seconds === null ? "" : ` in ${seconds}s`;
      return `Summarizing the abandoned branch (${status.attempt}/${status.maxAttempts})${wait}…`;
    }
    default:
      return "Working…";
  }
}

export function RunStatusRow({
  status,
  onCancel,
}: {
  status: TranscriptRunStatus;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // A retry/summary deadline ticks; a compaction has no deadline but the row
    // must still reflect a later `until` if the reducer replaces the status.
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      data-testid="run-status-row"
      className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-1 text-xs text-ink-muted"
    >
      <span className="animate-pulse text-accent" aria-hidden="true">
        ●
      </span>
      <span>{runStatusLabel(status, now)}</span>
      <span className="text-ink-subtle">Esc to cancel</span>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
