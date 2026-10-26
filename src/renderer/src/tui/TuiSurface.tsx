import { useEffect, useRef, type ReactElement } from "react";

import {
  bracketedPaste,
  domKeyToTerminalData,
  domWheelToTerminalData,
} from "../../../shared/terminal-keys";
import type { TuiFrame, TuiSurfaceSnapshot } from "../../../shared/tui-surface";
import { useAppStore } from "../state/app-store";
import { AnsiBlock } from "./AnsiBlock";
import { overlayPixelRect, type CellSize, type TuiGrid } from "./tui-geometry";

/**
 * The extension TUI surface (plan step 17; grid contract amended 2026-10-26).
 *
 * `ctx.ui.custom()` renders ANSI frames in the host; this displays them in a
 * monospace grid, forwards DOM keys as terminal bytes (so Pi's components see
 * the input they expect), frames a paste and scrolls a frame taller than its
 * viewport.
 *
 * The grid and the cell size belong to the session viewport, not to this
 * component (2026-10-26 plan, step 1): `SessionView` measures the session
 * column and passes `cell` in. Measuring the surface's own frame used to feed
 * `terminal.rows` back into the extension and collapsed row-aware components
 * (the workflow questionnaire) to a single row.
 *
 * `TuiSurface` owns the keyboard when a non-overlay `custom` component is
 * mounted, replacing the composer; `TuiOverlay` floats over the session view;
 * `TuiSlotFrame` renders the read-only header/footer slots. A custom editor is
 * never mounted: the native composer is always the editor.
 */

interface SurfaceInputHandlers {
  onKeyDown: (event: React.KeyboardEvent) => void;
  onPaste: (event: React.ClipboardEvent) => void;
  onWheel: (event: React.WheelEvent) => void;
}

/** Keys become terminal bytes; a plain wheel goes to the extension unless the fallback scroller overflows. */
function useSurfaceInput(
  onInput: (data: string) => void,
  scrollRef: React.RefObject<HTMLDivElement | null>,
  cell: CellSize,
): SurfaceInputHandlers {
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "PageUp" || event.key === "PageDown") {
      const node = scrollRef.current;
      if (node && node.scrollHeight > node.clientHeight + 1) {
        event.preventDefault();
        node.scrollTop += (event.key === "PageUp" ? -1 : 1) * node.clientHeight;
        return;
      }
    }
    const data = domKeyToTerminalData({
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    });
    if (data === null) return;
    event.preventDefault();
    onInput(data);
  };

  const onPaste = (event: React.ClipboardEvent): void => {
    const text = event.clipboardData?.getData("text");
    if (!text) return;
    event.preventDefault();
    onInput(bracketedPaste(text));
  };

  const onWheel = (event: React.WheelEvent): void => {
    const node = scrollRef.current;
    if (node && node.scrollHeight > node.clientHeight + 1) {
      node.scrollTop += event.deltaY;
      event.preventDefault();
      return;
    }
    // The frame fits its viewport: the wheel belongs to the extension (Pi's
    // terminal components read raw SGR wheel sequences). The local scroller is
    // only the fallback for a frame taller than the viewport.
    const rect = node?.getBoundingClientRect();
    const col = rect ? Math.floor((event.clientX - rect.left) / cell.width) : 0;
    const row = rect ? Math.floor((event.clientY - rect.top) / cell.height) : 0;
    const data = domWheelToTerminalData({
      deltaY: event.deltaY,
      deltaX: event.deltaX,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      col,
      row,
    });
    if (data === null) return;
    event.preventDefault();
    onInput(data);
  };

  return { onKeyDown, onPaste, onWheel };
}

function Cursor({ frame, cell }: { frame: TuiFrame; cell: CellSize }): ReactElement | null {
  if (!frame.cursor) return null;
  return (
    <span
      aria-hidden="true"
      data-tui-cursor=""
      className="pointer-events-none absolute block animate-pulse bg-accent"
      style={{
        top: frame.cursor.row * cell.height,
        left: frame.cursor.col * cell.width,
        width: cell.width,
        height: cell.height,
      }}
    />
  );
}

/** Hidden probe the session viewport measures to size one monospace cell. */
export function TuiCellProbe(): ReactElement {
  return (
    <span
      data-tui-cell-probe=""
      aria-hidden="true"
      className="pointer-events-none invisible absolute font-mono text-xs leading-tight"
    >
      W
    </span>
  );
}

export interface TuiSlotFrameProps {
  frame: TuiFrame;
  className?: string;
}

/** A read-only header/footer frame (no keyboard, no measurement). */
export function TuiSlotFrame({ frame, className }: TuiSlotFrameProps): ReactElement {
  return (
    <div className={className} data-tui-slot="">
      <AnsiBlock frame={frame} className="font-mono text-xs leading-tight" />
    </div>
  );
}

export interface TuiSurfaceProps {
  tabId: string;
  snapshot: TuiSurfaceSnapshot;
  /** The session viewport's monospace cell (measured by `SessionView`). */
  cell: CellSize;
  /** The session viewport's grid; sizes a docked sheet and clamps a float. */
  grid: TuiGrid;
  /**
   * `dock` renders in flow in the composer region (a non-overlay `custom`
   * panel, or a bottom-anchored full-width overlay such as the workflow
   * questionnaire). `float` positions the overlay over the session column with
   * no dim backdrop.
   */
  variant: "dock" | "float";
  /** Bumped when the session view reclaims the keyboard for this surface. */
  focusToken?: number;
}

/**
 * The keyboard-owning surface. The dock replaces the composer region; the float
 * is an absolute child of the session column. Neither is a page-level modal.
 */
export function TuiSurface({
  tabId,
  snapshot,
  cell,
  grid,
  variant,
  focusToken = 0,
}: TuiSurfaceProps): ReactElement | null {
  const sendTuiInput = useAppStore((state) => state.sendTuiInput);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const input = useSurfaceInput((data) => sendTuiInput(tabId, data), scrollRef, cell);

  const frame = snapshot.custom;
  useEffect(() => {
    if (frame) containerRef.current?.focus();
  }, [frame, focusToken]);

  if (!frame) return null;

  const body = (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      onWheel={input.onWheel}
    >
      <div className="relative inline-block">
        <AnsiBlock frame={frame} className="font-mono text-xs leading-tight" selection />
        <Cursor frame={frame} cell={cell} />
      </div>
    </div>
  );

  if (variant === "float") {
    const bounds = snapshot.bounds;
    const column = { width: grid.cols * cell.width, height: grid.rows * cell.height };
    const rect = bounds
      ? overlayPixelRect(bounds, cell, column)
      : { top: 0, left: 0, width: column.width, height: frame.height * cell.height };
    return (
      <div
        ref={containerRef}
        tabIndex={0}
        autoFocus
        data-tui-overlay=""
        data-tui-surface="overlay"
        aria-label="Extension dialog"
        className="absolute z-20 flex flex-col overflow-hidden border border-line bg-surface outline-none"
        style={rect}
        onKeyDown={input.onKeyDown}
        onPaste={input.onPaste}
      >
        {body}
      </div>
    );
  }

  // The dock is a real flex child of the session column: it never floats, the
  // transcript shrinks above it, and a component taller than the column scrolls
  // inside it instead of covering the transcript.
  const dockMaxHeight = grid.rows * cell.height;
  return (
    <div
      ref={containerRef}
      tabIndex={0}
      autoFocus
      data-tui-surface="dock"
      aria-label={snapshot.overlay ? "Extension dialog" : "Extension input"}
      className="relative flex min-h-0 shrink flex-col overflow-hidden border-t border-line bg-surface outline-none"
      style={{ maxHeight: dockMaxHeight }}
      onKeyDown={input.onKeyDown}
      onPaste={input.onPaste}
    >
      {snapshot.overlay ? null : (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1 text-[11px] text-ink-faint">
          <span className="font-medium text-ink-muted">Extension UI</span>
          <span>keys are forwarded to the extension</span>
        </div>
      )}
      {body}
    </div>
  );
}
