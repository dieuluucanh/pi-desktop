/**
 * The five product views' common frame.
 *
 * Before this shell each view was itself the scroll container:
 * `mx-auto max-w-4xl h-full overflow-y-auto`. That put the scrollbar at the
 * edge of the centred reading column — the middle of the window on a wide
 * display — and the mouse wheel did nothing while the pointer was over the side
 * gutters.
 *
 * The shell splits the two jobs: the **outer** element is the full-width
 * scroller (so the scrollbar sits at the far right and the wheel works
 * anywhere), and the **inner** element is the centred column that keeps the
 * view's readable width. A view only chooses its width and gap.
 */

import type { ReactNode } from "react";
import { cn } from "../ui/cn";

const WIDTHS = {
  standard: "max-w-4xl",
  narrow: "max-w-3xl",
} as const;

const GAPS = {
  4: "gap-4",
  5: "gap-5",
  6: "gap-6",
} as const;

export type ViewShellWidth = keyof typeof WIDTHS;
export type ViewShellGap = keyof typeof GAPS;

export interface ViewShellProps {
  children: ReactNode;
  /** The reading column's maximum width. Defaults to the wider 4xl. */
  width?: ViewShellWidth;
  /** The vertical rhythm between the view's sections. Defaults to 5. */
  gap?: ViewShellGap;
}

export function ViewShell({ children, width = "standard", gap = 5 }: ViewShellProps) {
  return (
    <div className="h-full overflow-y-auto" data-testid="view-scroll">
      <div
        className={cn(
          "mx-auto flex min-h-full w-full flex-col px-8 py-6",
          WIDTHS[width],
          GAPS[gap],
        )}
        data-testid="view-content"
      >
        {children}
      </div>
    </div>
  );
}
