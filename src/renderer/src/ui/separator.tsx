import { cn } from "./cn";

/** A one-pixel rule between regions of the app chrome. */
export function Separator({ className }: { className?: string }) {
  return <div role="separator" className={cn("h-px w-full shrink-0 bg-line", className)} />;
}
