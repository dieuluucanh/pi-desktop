import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
import type { ComponentPropsWithRef } from "react";
import { cn } from "./cn";

/**
 * Hover-card primitives (2026-11-01 commit-history plan) — Radix's interactive
 * hover surface, the first real tooltip in the app.
 *
 * A native `title` cannot host the commit card's copy buttons or selectable
 * message text, and the rail's History block is an `overflow-y-auto` scroller
 * that would clip an in-rail absolutely positioned panel. Portalling to the body
 * is what lets the card sit beside the rail (default `side="left"`), and Radix
 * keeps the content open while the user selects text.
 */

export const HoverCard = HoverCardPrimitive.Root;
export const HoverCardTrigger = HoverCardPrimitive.Trigger;

export function HoverCardContent({
  className,
  side = "left",
  align = "start",
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: ComponentPropsWithRef<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "z-50 w-80 max-w-[calc(100vw-16px)] max-h-[min(420px,calc(100vh-16px))] overflow-y-auto rounded-md border border-line bg-surface p-2 text-ink shadow-2xl outline-none",
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}
