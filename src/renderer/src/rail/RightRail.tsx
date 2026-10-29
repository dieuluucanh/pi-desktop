/**
 * The docked panel rail.
 *
 * A VS Code-style dock on the right edge of a session: an **always-visible**
 * vertical strip of menu entries (Source Control, Checkpoints, Documents) beside
 * one resizable **panel body**. Clicking an entry expands its body; clicking the
 * active entry collapses it back to the strip.
 *
 * The host owns only the chrome — the strip, the title row, the resize handle and
 * the scrolling model — and each body is supplied by the caller. That is what
 * keeps the strip from ever disappearing: the previous single-column rail
 * unmounted itself entirely when closed, so a closed rail had no affordance at
 * all.
 *
 * Two rules this file exists to hold:
 *
 *  - **No prefs write from render.** A persisted `activeMenu` that this session
 *    cannot show (Documents with no Office bridge) falls back to the first
 *    available menu for rendering only; the user's choice is left on disk (D15).
 *  - **The strip is a toolbar with one tab stop** (D16): the active entry carries
 *    `tabIndex={0}`, the rest `-1`, and the arrows move both focus and the stop.
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { useAppStore } from "../state/app-store";
import {
  RAIL_MENU_IDS,
  RAIL_MENU_LABELS,
  clampRailWidth,
  moveRailMenu,
  resolveActiveMenu,
  type RailMenuId,
} from "../../../shared/rail";
import { RailStrip } from "./RailStrip";

/** One menu to render: its id, an optional count badge, its body and its scroll model. */
export interface RailMenuSpec {
  id: RailMenuId;
  /** Shown in the strip when greater than zero (changed files, pane count, …). */
  count?: number;
  /**
   * Who scrolls. `"host"` (default) wraps the body in this file's one scroll
   * container; `"self"` means the body pins a region and scrolls another itself
   * (Source Control keeps the commit composer in view).
   */
  scroll?: "host" | "self";
  content: ReactNode;
}

export interface RightRailProps {
  /** The menus to show. `id`s the caller omits are absent from the strip. */
  menus: readonly RailMenuSpec[];
}

/** Keyboard resize step, so the handle is usable without a pointer. */
const KEYBOARD_RESIZE_STEP = 20;

export function RightRail({ menus }: RightRailProps) {
  const rail = useAppStore((state) => state.prefs.rail);
  const setRailOpen = useAppStore((state) => state.setRailOpen);
  const setRailWidth = useAppStore((state) => state.setRailWidth);

  // While dragging, the width comes from local state so the column follows the
  // pointer without writing every pixel through the preferences store. The ref
  // mirrors it because `pointerup` can arrive in the same batch as the last
  // `pointermove`, where React state would still hold the previous width.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragWidthRef = useRef<number | null>(null);
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  const available = menus.map((menu) => menu.id);
  const resolved = resolveActiveMenu(rail.activeMenu, rail.order, available);
  const activeMenu = resolved.menu;
  const spec = activeMenu ? menus.find((menu) => menu.id === activeMenu) : undefined;

  if (menus.length === 0) return null;

  const width = dragWidth ?? rail.width;
  const expanded = rail.open && spec !== undefined;

  const trackDrag = (next: number | null): void => {
    dragWidthRef.current = next;
    setDragWidth(next);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    dragStart.current = { x: event.clientX, width };
    trackDrag(width);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = dragStart.current;
    if (!start) return;
    // Dragging *left* widens the panel: it is anchored to the right edge.
    trackDrag(clampRailWidth(start.width - (event.clientX - start.x)));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragStart.current) return;
    dragStart.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const next = dragWidthRef.current ?? rail.width;
    trackDrag(null);
    if (next !== rail.width) setRailWidth(next);
  };

  return (
    <aside
      className="relative flex shrink-0 border-l border-line bg-surface"
      aria-label="Panels"
      data-testid="right-rail"
    >
      {expanded && spec ? (
        <section
          className="relative flex min-h-0 flex-col border-r border-line bg-surface"
          style={{ width }}
          aria-label={RAIL_MENU_LABELS[spec.id]}
          data-testid="rail-panel"
        >
          {/* The handle sits on the panel's inner edge, where a user reaches for it. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            aria-valuenow={width}
            tabIndex={0}
            className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-accent/40 focus:bg-accent/40 focus:outline-none"
            data-testid="right-rail-resize"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                setRailWidth(clampRailWidth(rail.width + KEYBOARD_RESIZE_STEP));
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                setRailWidth(clampRailWidth(rail.width - KEYBOARD_RESIZE_STEP));
              }
            }}
          />

          <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <h2 className="text-xs font-semibold">{RAIL_MENU_LABELS[spec.id]}</h2>
            <button
              type="button"
              className="ml-auto text-ink-faint hover:text-ink"
              aria-label="Collapse panel"
              onClick={() => setRailOpen(false)}
            >
              <X className="size-3" aria-hidden />
            </button>
          </header>

          {spec.scroll === "self" ? (
            <div className="flex min-h-0 flex-1 flex-col">{spec.content}</div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">{spec.content}</div>
          )}
        </section>
      ) : null}

      <RailStrip
        menus={resolved.menus}
        counts={countsOf(menus)}
        activeMenu={activeMenu}
        expanded={expanded}
        onToggle={(id) => useAppStore.getState().toggleRailMenu(id)}
        onMove={(id, to) =>
          useAppStore.getState().setRailMenuOrder(moveRailMenu(rail.order, id, to))
        }
        onResetOrder={() => useAppStore.getState().setRailMenuOrder([...RAIL_MENU_IDS])}
      />
    </aside>
  );
}

/** The count badges, keyed by menu id, for the menus actually supplied. */
function countsOf(menus: readonly RailMenuSpec[]): Partial<Record<RailMenuId, number>> {
  const counts: Partial<Record<RailMenuId, number>> = {};
  for (const menu of menus) if (menu.count !== undefined) counts[menu.id] = menu.count;
  return counts;
}
