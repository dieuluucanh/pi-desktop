/**
 * The rail's vertical menu strip.
 *
 * A 44 px column pinned to the right edge of a session: one icon per menu, the
 * active one highlighted, a count badge when there is something to count. It is
 * always mounted — that is the whole point of the docked design, because the old
 * single-column rail unmounted itself when closed and so had no affordance left.
 *
 * Two behaviours live here rather than in the host:
 *
 *  - **Roving tabindex (D16).** The strip is one `role="toolbar"`, which the ARIA
 *    pattern defines as a *single* tab stop. Exactly one entry has `tabIndex={0}`
 *    (the active one, else the first) and the arrows/Home/End move both focus and
 *    that tab stop, so `Tab` never walks the whole strip.
 *  - **User-adjustable order (D5).** Native HTML5 drag (the same mechanism the
 *    tab strip uses) for the mouse, plus an inline reorder list — *Move up / Move
 *    down / Move to top / Reset order* — so reordering never depends on a drag
 *    gesture and never on a pointer at all.
 *
 * The reorder list is deliberately **not** a Radix dropdown: a portal-anchored
 * popup in this column clips and steals pointer events (the same reason the
 * branch list in `GitSection` is inline), and its dismiss layer is a lock that
 * outlives the click.
 */

import { useState, type DragEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpToLine,
  Camera,
  FileStack,
  GitBranch,
  MoreVertical,
  RotateCcw,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { RAIL_MENU_LABELS, type RailMenuId, type RailMenuMove } from "../../../shared/rail";

/** The icon for each menu. Sized by the caller's class so the strip stays 44 px. */
const MENU_ICONS: Record<RailMenuId, typeof GitBranch> = {
  "source-control": GitBranch,
  checkpoints: Camera,
  documents: FileStack,
};

export interface RailStripProps {
  /** The entries to show, in strip order (already resolved for this session). */
  menus: readonly RailMenuId[];
  /** Optional count per menu, rendered as a badge when greater than zero. */
  counts: Partial<Record<RailMenuId, number>>;
  /** The menu whose body is shown (or would be, when collapsed). */
  activeMenu: RailMenuId | null;
  /** Whether the panel body is currently expanded. */
  expanded: boolean;
  /** The strip's click: switch menus, or collapse the active one. */
  onToggle: (id: RailMenuId) => void;
  /** Applies a reorder (drag drop or the reorder list). */
  onMove: (id: RailMenuId, to: RailMenuMove | number) => void;
  /** Restores the canonical order. */
  onResetOrder: () => void;
}

export function RailStrip({
  menus,
  counts,
  activeMenu,
  expanded,
  onToggle,
  onMove,
  onResetOrder,
}: RailStripProps) {
  const [dragId, setDragId] = useState<RailMenuId | null>(null);
  /** The entry whose inline reorder list is open, if any. */
  const [orderFor, setOrderFor] = useState<RailMenuId | null>(null);
  // The roving tab stop follows keyboard navigation; the active menu is the
  // initial value so a click and an arrow key agree on "here".
  const [tabStop, setTabStop] = useState<RailMenuId | null>(null);
  const focused = tabStop && menus.includes(tabStop) ? tabStop : (activeMenu ?? menus[0] ?? null);

  const moveFocus = (from: RailMenuId, offset: number | "first" | "last"): void => {
    const index = menus.indexOf(from);
    let next: number;
    if (offset === "first") next = 0;
    else if (offset === "last") next = menus.length - 1;
    else next = Math.min(menus.length - 1, Math.max(0, (index === -1 ? 0 : index) + offset));
    const id = menus[next];
    if (!id) return;
    setTabStop(id);
    // Focus follows the tab stop: the strip is a composite widget, so a keyboard
    // user reaches any entry with the arrows instead of tabbing through them.
    document
      .querySelector<HTMLElement>(`[data-testid="rail-strip"] [data-rail-menu="${id}"]`)
      ?.focus();
  };

  const drop = (event: DragEvent<HTMLButtonElement>, target: RailMenuId): void => {
    event.preventDefault();
    if (dragId && dragId !== target) onMove(dragId, menus.indexOf(target));
    setDragId(null);
  };

  /** Runs one reorder and closes the list; the strip keeps the focus. */
  const applyMove = (id: RailMenuId, to: RailMenuMove): void => {
    setOrderFor(null);
    onMove(id, to);
  };

  return (
    <div
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Panels"
      className="flex w-11 shrink-0 flex-col items-center gap-0.5 bg-sunken py-1"
      data-testid="rail-strip"
    >
      {menus.map((id, index) => {
        const Icon = MENU_ICONS[id];
        const label = RAIL_MENU_LABELS[id];
        const count = counts[id] ?? 0;
        const active = id === activeMenu;
        const isFirst = index === 0;
        const isLast = index === menus.length - 1;
        const reordering = orderFor === id;
        return (
          <div
            key={id}
            data-testid={`rail-menu-wrap-${id}`}
            className="group relative flex w-full flex-col items-center"
          >
            <button
              type="button"
              data-rail-menu={id}
              data-testid={`rail-menu-${id}`}
              aria-label={label}
              title={label}
              aria-expanded={active ? expanded : false}
              aria-controls={active ? "rail-panel" : undefined}
              tabIndex={id === focused ? 0 : -1}
              draggable
              onDragStart={() => setDragId(id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(event) => {
                if (dragId && dragId !== id) event.preventDefault();
              }}
              onDrop={(event) => drop(event, id)}
              onFocus={() => setTabStop(id)}
              onClick={() => onToggle(id)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  moveFocus(id, 1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  moveFocus(id, -1);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  moveFocus(id, "first");
                } else if (event.key === "End") {
                  event.preventDefault();
                  moveFocus(id, "last");
                }
              }}
              className={`relative flex h-9 w-9 items-center justify-center rounded-sm ${
                active
                  ? "bg-raised text-ink before:absolute before:-left-[7px] before:inset-y-1 before:w-0.5 before:rounded-full before:bg-accent"
                  : "text-ink-faint hover:bg-raised/60 hover:text-ink"
              } ${dragId === id ? "opacity-60" : ""}`}
            >
              <Icon className="size-4" aria-hidden />
              {count > 0 ? (
                <Badge
                  tone={active ? "accent" : "neutral"}
                  className="absolute -right-1 -top-1 min-w-4 justify-center px-1 py-0 text-[10px] leading-4"
                  data-testid={`rail-menu-count-${id}`}
                >
                  {count}
                </Badge>
              ) : null}
            </button>

            <button
              type="button"
              aria-label={`Reorder ${label}`}
              aria-expanded={reordering}
              aria-controls={reordering ? `rail-order-list-${id}` : undefined}
              title={`Reorder ${label}`}
              data-testid={`rail-order-${id}`}
              onClick={() => setOrderFor(reordering ? null : id)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOrderFor(null);
              }}
              className="absolute right-0 top-0 -mr-1 flex size-4 items-center justify-center rounded-xs text-ink-faint opacity-0 hover:text-ink focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <MoreVertical className="size-3" aria-hidden />
            </button>

            {reordering ? (
              // Inline, anchored under the strip rather than portalled over it:
              // a popup in this column clips and its dismiss lock outlives the
              // click (the branch list in `GitSection` is inline for the same
              // reason).
              <div
                id={`rail-order-list-${id}`}
                role="group"
                aria-label={`Reorder ${label}`}
                data-testid={`rail-order-list-${id}`}
                className="absolute right-full top-0 z-20 mr-1 w-36 rounded-sm border border-line bg-surface p-1 shadow-xl"
                onKeyDown={(event) => {
                  if (event.key === "Escape") setOrderFor(null);
                }}
              >
                <ReorderItem
                  label="Move up"
                  disabled={isFirst}
                  onSelect={() => applyMove(id, "up")}
                />
                <ReorderItem
                  label="Move down"
                  disabled={isLast}
                  onSelect={() => applyMove(id, "down")}
                />
                <ReorderItem
                  label="Move to top"
                  disabled={isFirst}
                  onSelect={() => applyMove(id, "top")}
                />
                <div className="my-1 h-px bg-line" />
                <ReorderItem
                  label="Reset order"
                  onSelect={() => {
                    setOrderFor(null);
                    onResetOrder();
                  }}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** One row of the inline reorder list: a plain button, so it is fully keyboard-reachable. */
function ReorderItem({
  label,
  disabled,
  onSelect,
}: {
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-xs px-1.5 py-1 text-left text-[11px] text-ink hover:bg-raised disabled:pointer-events-none disabled:opacity-40"
    >
      {label === "Move up" ? (
        <ArrowUp className="size-3" aria-hidden />
      ) : label === "Move down" ? (
        <ArrowDown className="size-3" aria-hidden />
      ) : label === "Move to top" ? (
        <ArrowUpToLine className="size-3" aria-hidden />
      ) : (
        <RotateCcw className="size-3" aria-hidden />
      )}
      {label}
    </button>
  );
}
