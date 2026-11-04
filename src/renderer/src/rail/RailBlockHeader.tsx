/**
 * A Source Control block's header, pinned to the top of its own scroller.
 *
 * Each of the three blocks in `SourceControlPanel` scrolls independently, so the
 * label of a block — and its one block-wide control (refresh) — must not travel
 * with the list it describes. Both `ChangesSection` and `HistorySection` render
 * this one component, which is the only place the sticky rule is stated:
 *
 *  - **`sticky top-0`, opaque `bg-surface`.** A transparent background would let
 *    rows ghost through the header while scrolling; the panel paints
 *    `bg-surface`, so the header paints it too.
 *  - **A fixed `h-7`.** The height is the sticky offset contract for the group
 *    headers inside the block: `ChangesSection` pins them at `top-7`, which is
 *    exactly this header's height. A different height here would leave a gap or
 *    overlap rows.
 *  - **A hairline bottom border.** It stays visible at rest (the same separator
 *    the panel header uses), so the pinned state needs no scroll listener.
 *  - **`z-10`.** Above the rows it covers, below dialogs/portals.
 *
 * The padding matches the panel's own header (`px-3`), so the block titles line
 * up with the menu title above them.
 */

import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "../ui/badge";

export interface RailBlockHeaderProps {
  /** The block's name, e.g. `Changes` or `Commit History`. */
  title: string;
  /** Test id for the header row (`changes-header`, `history-header`, …). */
  testId: string;
  /** Shown as a badge when defined; omitted rather than rendered as `0`. */
  count?: number | string;
  /** Test id for that badge, when callers assert on it. */
  countTestId?: string;
  /** Renders the icon-only refresh button at the trailing edge. */
  onRefresh?: () => void;
  /** Accessible name *and* tooltip for the refresh button (no visible label). */
  refreshLabel?: string;
  /** Extra trailing controls, placed before the refresh button. */
  children?: ReactNode;
}

export function RailBlockHeader({
  title,
  testId,
  count,
  countTestId,
  onRefresh,
  refreshLabel,
  children,
}: RailBlockHeaderProps) {
  return (
    <div
      className="sticky top-0 z-10 flex h-7 shrink-0 items-center gap-2 border-b border-line bg-surface px-3"
      data-testid={testId}
    >
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>
      {count === undefined ? null : (
        <Badge tone="neutral" data-testid={countTestId}>
          {count}
        </Badge>
      )}
      {children}
      {onRefresh ? (
        <button
          type="button"
          className="ml-auto shrink-0 text-ink-faint hover:text-ink"
          aria-label={refreshLabel}
          title={refreshLabel}
          onClick={onRefresh}
        >
          <RefreshCw className="size-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
