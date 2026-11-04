import type { TuiFrame } from "../../../shared/tui-surface";
import { AnsiBlock, AnsiInlineFrame } from "./AnsiBlock";

/**
 * Component-factory extension widgets (2026-10-26 plan, step 5).
 *
 * Pi's `ctx.ui.setWidget(key, (tui, theme) => Component)` renders a component
 * above or below the editor. The host renders each widget through the emulated
 * TUI and sends the ANSI frames here; the string-array form of the same API
 * keeps the existing `oi.state` path (`WidgetStrip`).
 *
 * Widgets are read-only: they never take the keyboard and never mark a
 * selection, so `AnsiBlock` runs without the selection treatment.
 */
export function TuiWidgetStrip({
  frames,
  placement,
}: {
  frames: readonly TuiFrame[];
  placement: "aboveEditor" | "belowEditor";
}) {
  if (frames.length === 0) return null;
  return (
    <div
      data-tui-widgets={placement}
      className="flex max-h-60 shrink-0 flex-col overflow-y-auto border-t border-line bg-surface font-mono text-xs leading-tight"
    >
      {frames.map((frame) => (
        <AnsiBlock key={frame.seq} frame={frame} className="font-mono text-xs leading-tight" />
      ))}
    </div>
  );
}

/**
 * Single-line widget frames rendered as footer columns (2026-10-31 UI plan).
 * They share the session footer's row instead of taking a strip of their own.
 */
export function TuiWidgetInline({ frames }: { frames: readonly TuiFrame[] }) {
  if (frames.length === 0) return null;
  return (
    <>
      {frames.map((frame) => (
        <AnsiInlineFrame key={frame.seq} frame={frame} className="min-w-0 max-w-[48ch] truncate" />
      ))}
    </>
  );
}
