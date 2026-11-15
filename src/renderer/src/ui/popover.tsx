import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ComponentPropsWithRef } from "react";
import { cn } from "./cn";

/**
 * Popover primitives (2026-11-15 notification-dismissal plan) — Radix's
 * light-dismiss surface for the status-bar notification bell.
 *
 * Radix owns the parts a hand-rolled popover gets wrong: outside pointerdown
 * (without swallowing the click), Escape (returning focus to the trigger),
 * trigger toggling and collision-aware placement. Portalling matters twice
 * here: the 28 px status-bar footer must not clip the panel, and the existing
 * `[data-radix-popper-content-wrapper]` overlay selector is what makes a native
 * `WebContentsView` step aside while the panel is open.
 */

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({
  align = "end",
  className,
  collisionPadding = 8,
  sideOffset = 8,
  ...props
}: ComponentPropsWithRef<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        collisionPadding={collisionPadding}
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-w-[calc(100vw-16px)] rounded-md border border-line bg-surface p-2 text-ink shadow-xl outline-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
