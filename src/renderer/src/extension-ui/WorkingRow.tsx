import { useEffect, useState } from "react";
import type { ExtensionWorkingState } from "../../../shared/extension-ui";

/**
 * The working row (plan step 16).
 *
 * `ctx.ui.setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` drive
 * this strip above the composer. Custom `frames` animate at `intervalMs`; with no
 * frames the app's default pulsing marker is used. An empty `frames` array hides
 * the indicator, exactly as Pi documents.
 *
 * 2026-10-26 session-parity plan step 8: the row also renders for a running
 * session with no extension state at all (an extension must not be required for
 * a working indicator), and shows elapsed time plus an action hint. The hint is
 * context-aware: a review pauses, an ordinary run cancels.
 */

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

export function WorkingRow({
  working,
  startedAt = null,
  showCancelHint = false,
  cancelHint = "Esc to cancel",
}: {
  working: ExtensionWorkingState;
  /** Epoch ms when the turn started; renders elapsed time when present. */
  startedAt?: number | null;
  /** Renders the desktop's action hint on the right (plan step 8). */
  showCancelHint?: boolean;
  /** Action hint text; a review uses “ESC to pause · …”. */
  cancelHint?: string;
}) {
  const frames = working.frames;
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!frames || frames.length <= 1) return;
    const interval = setInterval(() => {
      setFrame((value) => (value + 1) % frames.length);
    }, working.intervalMs ?? 100);
    return () => clearInterval(interval);
  }, [frames, working.intervalMs]);

  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (working.visible === false) return null;
  if (frames && frames.length === 0) return null;

  const marker = frames && frames.length > 0 ? (frames[frame % frames.length] ?? "") : "●";
  const elapsed = startedAt === null ? null : formatElapsed(now - startedAt);

  return (
    <div
      data-testid="extension-working-row"
      className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-1 text-xs text-ink-muted"
    >
      <span className={frames && frames.length > 0 ? "font-mono" : "animate-pulse text-accent"}>
        {marker}
      </span>
      <span>{working.message ?? "Working…"}</span>
      {elapsed === null ? null : <span className="text-ink-subtle">{elapsed}</span>}
      {showCancelHint ? <span className="text-ink-subtle">{cancelHint}</span> : null}
    </div>
  );
}
