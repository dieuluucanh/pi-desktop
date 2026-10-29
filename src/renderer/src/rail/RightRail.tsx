/**
 * The right rail host (git-checkpoint plan step 10).
 *
 * One resizable column with independently collapsible sections — Git, Changes,
 * Checkpoints and Documents — replacing the single-purpose Documents panel. The
 * host owns only the chrome: the header, the resize handle, and the per-section
 * expand/collapse state that `prefs.rail` persists. Each body is supplied by the
 * caller, so a section that lands in a later step simply is not passed yet
 * instead of appearing as an empty shell.
 *
 * The old Documents panel was gated on the Office bridge answering `/health`;
 * that rule still holds, because `DocumentsSection` renders nothing when the
 * bridge is absent, and `SessionView` only registers the section when there is
 * something to show.
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, PanelRightClose } from "lucide-react";
import { Badge } from "../ui/badge";
import { useAppStore } from "../state/app-store";
import { RAIL_SECTION_LABELS, clampRailWidth, type RailSectionId } from "../../../shared/rail";

/** One section to render: its id, an optional count badge, and its body. */
export interface RailSectionSpec {
  id: RailSectionId;
  /** Shown in the header when greater than zero (file count, pane count, …). */
  count?: number;
  content: ReactNode;
}

export interface RightRailProps {
  /** The sections to show, in order. A section the caller omits is absent. */
  sections: readonly RailSectionSpec[];
}

/** Keyboard resize step, so the handle is usable without a pointer. */
const KEYBOARD_RESIZE_STEP = 20;

function RailSection({
  spec,
  expanded,
  onToggle,
  onRove,
}: {
  spec: RailSectionSpec;
  expanded: boolean;
  onToggle: () => void;
  /** Moves focus between section headers (Arrow Up/Down, Home/End). */
  onRove: (offset: number | "first" | "last") => void;
}) {
  const bodyId = `rail-body-${spec.id}`;
  return (
    <section
      role="region"
      // An explicit label (not `aria-labelledby`) so the count badge's text does
      // not become part of the region's name for screen readers.
      aria-label={RAIL_SECTION_LABELS[spec.id]}
      className="border-b border-line last:border-b-0"
      data-testid={`rail-section-${spec.id}`}
    >
      <h3 id={`rail-heading-${spec.id}`} className="m-0">
        <button
          type="button"
          data-rail-header=""
          className="flex w-full items-center gap-1 px-3 py-2 text-left text-xs font-semibold hover:bg-raised/50"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
          onKeyDown={(event) => {
            // Roving focus: the headers are one composite widget, so a keyboard
            // user can move between sections without tabbing through every row.
            if (event.key === "ArrowDown") {
              event.preventDefault();
              onRove(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              onRove(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              onRove("first");
            } else if (event.key === "End") {
              event.preventDefault();
              onRove("last");
            }
          }}
        >
          {expanded ? (
            <ChevronDown className="size-3 shrink-0 text-ink-faint" aria-hidden />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-ink-faint" aria-hidden />
          )}
          <span className="flex-1 truncate">{RAIL_SECTION_LABELS[spec.id]}</span>
          {spec.count !== undefined && spec.count > 0 ? (
            <Badge tone="neutral">{spec.count}</Badge>
          ) : null}
        </button>
      </h3>
      {expanded ? (
        <div id={bodyId} className="flex min-h-0 flex-col">
          {spec.content}
        </div>
      ) : null}
    </section>
  );
}

export function RightRail({ sections }: RightRailProps) {
  const rail = useAppStore((state) => state.prefs.rail);
  const toggleRail = useAppStore((state) => state.toggleRail);
  const toggleRailSection = useAppStore((state) => state.toggleRailSection);
  const setRailWidth = useAppStore((state) => state.setRailWidth);

  // While dragging, the width comes from local state so the column follows the
  // pointer without writing every pixel through the preferences store. The ref
  // mirrors it because `pointerup` can arrive in the same batch as the last
  // `pointermove`, where React state would still hold the previous width.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragWidthRef = useRef<number | null>(null);
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  if (!rail.open) return null;

  const width = dragWidth ?? rail.width;

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
    // Dragging *left* widens the rail: it is anchored to the right edge.
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

  /**
   * Moves focus between the section headers. The headers behave as one
   * composite widget, so a keyboard user reaches any section with the arrows
   * instead of tabbing through every row inside the expanded ones.
   */
  const roveSectionFocus = (offset: number | "first" | "last"): void => {
    const headers = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="right-rail"] [data-rail-header]'),
    ];
    if (headers.length === 0) return;
    const current = headers.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (offset === "first") next = 0;
    else if (offset === "last") next = headers.length - 1;
    else next = Math.min(headers.length - 1, Math.max(0, (current === -1 ? 0 : current) + offset));
    headers[next]?.focus();
  };

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-line bg-surface"
      style={{ width }}
      aria-label="Session panel"
      data-testid="right-rail"
    >
      {/* The handle sits on the rail's inner edge, where a user reaches for it. */}
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
        <h2 className="text-xs font-semibold">Panel</h2>
        <button
          type="button"
          className="ml-auto text-ink-faint hover:text-ink"
          aria-label="Close panel"
          onClick={toggleRail}
        >
          <PanelRightClose className="size-3" aria-hidden />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {sections.length === 0 ? (
          <p className="px-3 py-4 text-xs text-ink-muted" data-testid="rail-empty">
            Nothing to show for this tab yet. Open a session in a folder to see its git state and
            checkpoints.
          </p>
        ) : (
          sections.map((spec) => (
            <RailSection
              key={spec.id}
              spec={spec}
              expanded={rail.sections[spec.id]}
              onToggle={() => toggleRailSection(spec.id)}
              onRove={roveSectionFocus}
            />
          ))
        )}
      </div>
    </aside>
  );
}
