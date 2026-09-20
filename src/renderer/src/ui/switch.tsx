import type { ComponentPropsWithRef } from "react";
import { cn } from "./cn";

/**
 * Switch (plan step 1/12). A plain button with `role="switch"` rather than a
 * Radix primitive: it needs one visual state, keyboard support comes for free
 * from `<button>`, and it keeps the renderer dependency list unchanged.
 */
export interface SwitchProps extends Omit<
  ComponentPropsWithRef<"button">,
  "onChange" | "role" | "aria-checked"
> {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
}

export function Switch({ checked, onCheckedChange, className, disabled, ...props }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors disabled:pointer-events-none disabled:opacity-50",
        checked ? "border-accent bg-accent" : "border-line-strong bg-sunken",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none block size-3 rounded-full bg-surface transition-transform",
          checked ? "translate-x-3.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
