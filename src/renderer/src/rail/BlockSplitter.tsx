/**
 * A horizontal splitter between two of Source Control's three blocks.
 *
 * This is the horizontal sibling of `RightRail`'s vertical resize handle: the
 * same pointer-capture + keyboard contract, but it trades **height** between two
 * stacked blocks instead of width between two columns.
 *
 * Three rules make it safe to use against persisted state (plan D2):
 *
 *  - **Measure at drag time, not at render time.** The container height is read
 *    from `containerRef` on each move, so the px floor ({@link MIN_BLOCK_PX})
 *    applies to the panel as it is *now*. jsdom has no layout, which is why the
 *    arithmetic itself lives in `railSplitWithDelta` and takes the height as an
 *    argument.
 *  - **Never write per pixel.** A drag is held in local state and committed as
 *    one `onChange` on release. A render-time clamp is never persisted: the
 *    displayed split may differ from the stored one in a short window, and
 *    writing that difference back would silently rewrite the user's preference.
 *  - **Every gesture is on the keyboard too.** Arrows nudge, `Shift` nudges
 *    further, `Home`/`End` go to the floors, and double-click resets.
 */

import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import {
  MAX_SPLIT_FRACTION,
  MIN_BLOCK_PX,
  MIN_SPLIT_FRACTION,
  SPLITTER_KEYBOARD_STEP,
  SPLITTER_KEYBOARD_STEP_LARGE,
  railSplitFractions,
  railSplitWithDelta,
  type RailSplitEdge,
  type RailSplitPrefs,
} from "../../../shared/rail";

export interface BlockSplitterProps {
  /** Which boundary this handle moves: block 1|2 (`top`) or block 2|3 (`middle`). */
  edge: RailSplitEdge;
  /** The split to render from; local state only diverges while dragging. */
  split: RailSplitPrefs;
  /** The element whose height bounds the drag (the three-block panel). */
  containerRef: RefObject<HTMLElement | null>;
  /** Accessible name, e.g. "Resize Source Control and Changes". */
  label: string;
  /** Called **once** per gesture — on pointer release, per key press, on reset. */
  onChange: (split: RailSplitPrefs) => void;
  /**
   * Called with the in-flight split while dragging (and `null` when the gesture
   * ends). The owner renders from this so the blocks follow the pointer without
   * persisting per pixel.
   */
  onPreview?: (split: RailSplitPrefs | null) => void;
  /** Double-click: restore the default split. */
  onReset: () => void;
}

/** A percent for `aria-valuenow`: the boundary's position from the top. */
function boundaryPercent(split: RailSplitPrefs, edge: RailSplitEdge): number {
  const fractions = railSplitFractions(split);
  const boundary = edge === "top" ? fractions.top : fractions.top + fractions.middle;
  return Math.round(boundary * 100);
}

export function BlockSplitter({
  edge,
  split,
  containerRef,
  label,
  onChange,
  onPreview,
  onReset,
}: BlockSplitterProps): React.JSX.Element {
  // The in-flight drag: the split at pointer-down plus the pointer's origin. A
  // ref (not state) because pointerup can land in the same batch as the last
  // move, where React state would still hold the previous value.
  const dragStart = useRef<{ y: number; split: RailSplitPrefs } | null>(null);
  // The next split while dragging, mirrored in state so the blocks follow the
  // pointer. `null` means "use the persisted split".
  const [dragSplit, setDragSplit] = useState<RailSplitPrefs | null>(null);
  const dragSplitRef = useRef<RailSplitPrefs | null>(null);

  const shown = dragSplit ?? split;

  const trackDrag = (next: RailSplitPrefs | null): void => {
    dragSplitRef.current = next;
    setDragSplit(next);
    onPreview?.(next);
  };

  const containerHeight = (): number => containerRef.current?.clientHeight ?? 0;

  const moveTo = (deltaPx: number): void => {
    const start = dragStart.current;
    if (!start) return;
    trackDrag(railSplitWithDelta(start.split, edge, deltaPx, containerHeight()));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    dragStart.current = { y: event.clientY, split };
    trackDrag(split);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragStart.current) return;
    moveTo(event.clientY - dragStart.current.y);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragStart.current) return;
    dragStart.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const next = dragSplitRef.current;
    trackDrag(null);
    // One write for the whole gesture; a drag that lands where it started is not
    // a change and must not churn `app-state.json`.
    if (next && (next.top !== split.top || next.middle !== split.middle)) onChange(next);
  };

  const nudge = (direction: 1 | -1, step: number): void => {
    onChange(railSplitWithDelta(split, edge, direction * step, containerHeight()));
  };

  const toBound = (bound: "floor" | "ceiling"): void => {
    const fractions = railSplitFractions(split);
    const body = containerHeight();
    // Whichever floor is stricter: the fraction band, or the px floor measured
    // against the panel as it is right now.
    const floor = body > 0 ? Math.max(MIN_SPLIT_FRACTION, MIN_BLOCK_PX / body) : MIN_SPLIT_FRACTION;

    if (edge === "top") {
      // History is the fixed third at this edge, so Top and Changes share the
      // rest — the same rule the drag and the arrow keys follow.
      const history = Math.max(floor, 1 - fractions.top - fractions.middle);
      const ceiling = Math.max(floor, Math.min(MAX_SPLIT_FRACTION, 1 - history - floor));
      const top = bound === "floor" ? floor : ceiling;
      onChange({ top, middle: 1 - top - history });
      return;
    }

    // Top is fixed; Changes and History share the rest.
    const ceiling = Math.max(floor, Math.min(MAX_SPLIT_FRACTION, 1 - fractions.top - floor));
    const middle = bound === "floor" ? floor : ceiling;
    onChange({ top: fractions.top, middle });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? SPLITTER_KEYBOARD_STEP_LARGE : SPLITTER_KEYBOARD_STEP;
    // Dragging down grows the block above the boundary, so `ArrowDown` is +1.
    if (event.key === "ArrowDown") {
      event.preventDefault();
      nudge(1, step);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      nudge(-1, step);
    } else if (event.key === "Home") {
      event.preventDefault();
      toBound("floor");
    } else if (event.key === "End") {
      event.preventDefault();
      toBound("ceiling");
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={boundaryPercent(shown, edge)}
      aria-valuemin={Math.round(MIN_SPLIT_FRACTION * 100)}
      aria-valuemax={Math.round(MAX_SPLIT_FRACTION * 100)}
      aria-valuetext={`${boundaryPercent(shown, edge)}% of the panel`}
      tabIndex={0}
      className="group relative h-px shrink-0 cursor-row-resize bg-line hover:bg-accent/40 focus:bg-accent/40 focus:outline-none"
      data-testid={`rail-splitter-${edge}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    >
      {/* A 1 px line with a taller invisible hit area, so the handle is grabbable. */}
      <span aria-hidden className="absolute inset-x-0 -inset-y-1" />
    </div>
  );
}
