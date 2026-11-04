import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import type { ComponentPropsWithRef } from "react";
import { cn } from "./cn";

/**
 * Context-menu primitives, styled exactly like `dropdown-menu.tsx`.
 *
 * Radix owns the a11y wiring and the menu positioning; keeping the styling in
 * one place means a tab's right-click menu and its “…” menu look identical.
 */

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuGroup = ContextMenuPrimitive.Group;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

export function ContextMenuContent({
  className,
  ...props
}: ComponentPropsWithRef<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        className={cn(
          "z-50 min-w-44 overflow-hidden rounded-md border border-line bg-surface p-1 text-ink shadow-2xl",
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  destructive,
  ...props
}: ComponentPropsWithRef<typeof ContextMenuPrimitive.Item> & { destructive?: boolean }) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded-xs px-2 py-1.5 text-xs outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-raised",
        destructive ? "text-danger data-[highlighted]:bg-danger/10" : "text-ink",
        className,
      )}
      {...props}
    />
  );
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentPropsWithRef<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator className={cn("my-1 h-px bg-line", className)} {...props} />
  );
}

export function ContextMenuLabel({
  className,
  ...props
}: ComponentPropsWithRef<typeof ContextMenuPrimitive.Label>) {
  return (
    <ContextMenuPrimitive.Label
      className={cn("px-2 py-1 text-[10px] uppercase tracking-wide text-ink-faint", className)}
      {...props}
    />
  );
}
