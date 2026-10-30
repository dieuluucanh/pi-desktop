/**
 * One row in a rail's inline menu (2026-10-30 rail-shell-checkpoint plan).
 *
 * The rail is only 320 px wide, so its menus are inline lists rather than
 * portal popups. The one layout rule every row follows is a **fixed leading
 * slot**: a checkbox item draws its check there, an action item leaves it
 * empty. That is what keeps "Amend last commit" and "Change identity" on the
 * same vertical line instead of one having a gutter and the other not.
 */

import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "../ui/cn";

export interface RailMenuItemProps {
  children: ReactNode;
  onSelect: () => void;
  /** Action rows default to `"menuitem"`; a check row uses `"menuitemcheckbox"`. */
  role?: "menuitem" | "menuitemcheckbox";
  /** Required for `role="menuitemcheckbox"`, ignored otherwise. */
  checked?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function RailMenuItem({
  children,
  onSelect,
  role = "menuitem",
  checked,
  ariaLabel,
  className,
}: RailMenuItemProps) {
  const checkable = role === "menuitemcheckbox";
  return (
    <button
      type="button"
      role={role}
      {...(checkable ? { "aria-checked": checked === true } : {})}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      data-testid="rail-menu-item"
      data-rail-menu-kind={checkable ? "check" : "action"}
      className={cn(
        // The slot is part of the row, not a child of the label: every row has
        // exactly the same text origin whether or not it shows a check.
        "flex w-full items-center gap-2 rounded-xs px-1 py-0.5 text-left text-[11px] leading-none hover:bg-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line-strong",
        className,
      )}
      onClick={onSelect}
    >
      <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
        {checkable && checked === true ? <Check className="size-3" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}
