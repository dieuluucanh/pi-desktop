import type { ComponentPropsWithRef } from "react";
import { cn } from "./cn";

/** A keyboard key rendered as a physical key cap. */
export function Kbd({ className, ...props }: ComponentPropsWithRef<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-line bg-sunken px-1.5 font-mono text-[11px] text-ink-muted",
        className,
      )}
      {...props}
    />
  );
}
