import { useEffect, useState } from "react";
import type { ExtensionWorkingState } from "../../../shared/extension-ui";

/**
 * The working row (plan step 16).
 *
 * `ctx.ui.setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` drive
 * this strip above the composer. Custom `frames` animate at `intervalMs`; with no
 * frames the app's default pulsing marker is used. An empty `frames` array hides
 * the indicator, exactly as Pi documents.
 */
export function WorkingRow({ working }: { working: ExtensionWorkingState }) {
  const frames = working.frames;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!frames || frames.length <= 1) return;
    const interval = setInterval(() => {
      setFrame((value) => (value + 1) % frames.length);
    }, working.intervalMs ?? 100);
    return () => clearInterval(interval);
  }, [frames, working.intervalMs]);

  if (working.visible === false) return null;
  if (frames && frames.length === 0) return null;

  const marker = frames && frames.length > 0 ? (frames[frame % frames.length] ?? "") : "●";

  return (
    <div
      data-testid="extension-working-row"
      className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-1 text-xs text-ink-muted"
    >
      <span className={frames && frames.length > 0 ? "font-mono" : "animate-pulse text-accent"}>
        {marker}
      </span>
      <span>{working.message ?? "Working…"}</span>
    </div>
  );
}
