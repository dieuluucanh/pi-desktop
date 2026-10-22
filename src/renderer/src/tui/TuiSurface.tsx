import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";

import { bracketedPaste, domKeyToTerminalData } from "../../../shared/terminal-keys";
import type { TuiFrame, TuiSurfaceSnapshot } from "../../../shared/tui-surface";
import { useAppStore } from "../state/app-store";
import { AnsiBlock } from "./AnsiBlock";

/**
 * The extension TUI surface (plan step 17).
 *
 * `ctx.ui.custom()` renders ANSI frames in the host; this displays them in a
 * monospace grid, forwards DOM keys as terminal bytes (so Pi's components see
 * the input they expect), frames a paste, reports the measured grid so overlays
 * re-resolve, and scrolls a frame taller than its viewport.
 *
 * `TuiSurface` owns the keyboard when a `custom` (non-overlay) or `editor`
 * component is mounted, replacing the composer; `TuiOverlay` floats over the
 * session view; `TuiSlotFrame` renders the read-only header/footer slots.
 */

const FALLBACK_CELL = { width: 8, height: 16 };
const DEFAULT_GRID = { rows: 24, cols: 80 };

interface CellSize {
  width: number;
  height: number;
}

/**
 * Measures the monospace cell from a hidden probe. jsdom reports a zero-size
 * rect, so tests keep the fallback; the real app measures the live font.
 */
function useCellSize(containerRef: React.RefObject<HTMLElement | null>): CellSize {
  const [cell, setCell] = useState<CellSize>(FALLBACK_CELL);
  useLayoutEffect(() => {
    const probe = containerRef.current?.querySelector<HTMLElement>("[data-tui-cell-probe]");
    if (!probe) return;
    const rect = probe.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) setCell({ width: rect.width, height: rect.height });
  }, [containerRef]);
  return cell;
}

/** The grid the host should render for, reported on every change. */
function useGrid(
  containerRef: React.RefObject<HTMLElement | null>,
  cell: CellSize,
  report: (rows: number, cols: number) => void,
): { rows: number; cols: number } {
  const [grid, setGrid] = useState(DEFAULT_GRID);
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const measure = (): void => {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const rows = Math.max(1, Math.floor(rect.height / cell.height));
      const cols = Math.max(1, Math.floor(rect.width / cell.width));
      setGrid((previous) =>
        previous.rows === rows && previous.cols === cols ? previous : { rows, cols },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [containerRef, cell.width, cell.height]);

  useEffect(() => {
    report(grid.rows, grid.cols);
  }, [report, grid.rows, grid.cols]);

  return grid;
}

interface SurfaceInputHandlers {
  onKeyDown: (event: React.KeyboardEvent) => void;
  onPaste: (event: React.ClipboardEvent) => void;
  onWheel: (event: React.WheelEvent) => void;
}

/** Keys become terminal bytes; PageUp/PageDown scroll locally when overflowing. */
function useSurfaceInput(
  onInput: (data: string) => void,
  scrollRef: React.RefObject<HTMLDivElement | null>,
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
    }
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

/** Hidden probe used to measure one monospace cell. */
function CellProbe(): ReactElement {
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
}

/**
 * The keyboard-owning surface. Renders a panel in the composer's place for a
 * non-overlay `custom`/`editor` component, or a modal overlay when the host
 * resolved an overlay rectangle.
 */
export function TuiSurface({ tabId, snapshot }: TuiSurfaceProps): ReactElement | null {
  const sendTuiInput = useAppStore((state) => state.sendTuiInput);
  const resizeTuiSurface = useAppStore((state) => state.resizeTuiSurface);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cell = useCellSize(containerRef);
  const report = (rows: number, cols: number): void => resizeTuiSurface(tabId, rows, cols);
  useGrid(containerRef, cell, report);
  const input = useSurfaceInput((data) => sendTuiInput(tabId, data), scrollRef);

  const frame = snapshot.custom ?? snapshot.editor;
  const isOverlay = snapshot.overlay && snapshot.bounds !== null && snapshot.custom !== null;
  useEffect(() => {
    if (frame) containerRef.current?.focus();
  }, [frame]);

  if (!frame) return null;

  const body = (
    <>
      <CellProbe />
      <div ref={scrollRef} className="max-h-72 overflow-auto px-2 pb-2" onWheel={input.onWheel}>
        <div className="relative inline-block">
          <AnsiBlock frame={frame} className="font-mono text-xs leading-tight" selection />
          <Cursor frame={frame} cell={cell} />
        </div>
      </div>
    </>
  );

  if (isOverlay) {
    const bounds = snapshot.bounds;
    return (
      <div className="absolute inset-0 z-40" data-tui-overlay="">
        <div className="absolute inset-0 bg-black/40" />
        <div
          ref={containerRef}
          tabIndex={0}
          autoFocus
          data-tui-surface="overlay"
          aria-label="Extension dialog"
          // The overlay owns the keyboard while it is up, so it wears the
          // accent border (plan step 2).
          className="absolute overflow-hidden rounded-sm border border-accent bg-surface shadow-lg outline-none"
          style={{
            top: (bounds?.row ?? 0) * cell.height,
            left: (bounds?.col ?? 0) * cell.width,
            width: (bounds?.width ?? 40) * cell.width,
          }}
          onKeyDown={input.onKeyDown}
          onPaste={input.onPaste}
        >
          {body}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      autoFocus
      data-tui-surface="panel"
      aria-label="Extension input"
      // While the panel is up it *is* the editor: the composer is gone and the
      // keys go to the extension. The caption says that in words and the
      // accent border says it at a glance (plan step 2).
      className="mx-3 my-2 max-h-80 overflow-hidden rounded-sm border border-accent bg-sunken outline-none"
      onKeyDown={input.onKeyDown}
      onPaste={input.onPaste}
    >
      <div className="flex items-center gap-2 border-b border-line px-2 py-1 text-[11px] text-ink-faint">
        <span className="font-medium text-ink-muted">Extension UI</span>
        <span>keys are forwarded to the extension</span>
      </div>
      {body}
    </div>
  );
}
