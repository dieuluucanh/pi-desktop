import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, type ComponentPropsWithRef } from "react";
import { cn } from "./cn";
import { scheduleBodyPointerLockCheck } from "./body-pointer-lock";

/**
 * Dialog primitives (plan step 1) — used by the command palette, later by
 * extension-driven dialogs (step 16) and the trust prompt (step 10).
 * Focus trapping, escape handling and aria wiring come from Radix.
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export function DialogOverlay({
  className,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn("fixed inset-0 z-40 bg-black/55 backdrop-blur-[1px]", className)}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Content>) {
  // Radix restores the body pointer-events lock when its dismissable layer
  // unmounts. If a duplicate copy of that package (or another library) left
  // `pointer-events: none` behind, this is the last moment the app can repair
  // it without the user losing the whole window. The check is a no-op while a
  // dialog/menu/popover is still open.
  useEffect(() => () => scheduleBodyPointerLockCheck(), []);

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-[10vh] z-50 w-[min(680px,92vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-surface text-ink shadow-2xl",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogTitle({
  className,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("px-4 pt-4 text-sm font-semibold", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentPropsWithRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("px-4 pb-2 text-xs text-ink-muted", className)}
      {...props}
    />
  );
}
