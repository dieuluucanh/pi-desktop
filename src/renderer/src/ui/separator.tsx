import { cn } from "./cn";

/**
 * A one-pixel rule between regions of the app chrome.
 *
 * `orientation` is not decoration: a vertical rule must say so, or assistive
 * tech reads it as a horizontal separator (plan step 6).
 */
export function Separator({
  className,
  orientation = "horizontal",
}: {
  className?: string;
  orientation?: "horizontal" | "vertical";
}) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cn(
        "shrink-0 bg-line",
        orientation === "vertical" ? "h-4 w-px" : "h-px w-full",
        className,
      )}
    />
  );
}
