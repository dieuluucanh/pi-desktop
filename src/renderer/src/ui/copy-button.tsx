/**
 * The copy icon button (2026-11-06 copy feedback).
 *
 * A copy action that only sets a global hint looks like a dead button: the hint
 * lives in the status bar, far from the click. This primitive reports the
 * outcome where the user clicked — a Check for success, an X for failure, a
 * tooltip change, and a polite live region for a screen reader — then resets
 * after 1.5 s. `copyText` already owns the clipboard fallback and the failure
 * answer, so this component only renders the result.
 */

import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./button";
import { copyText } from "./clipboard";
import { cn } from "./cn";

type CopyStatus = "idle" | "copied" | "failed";

/** How long the success/failure icon stays before returning to Copy. */
export const COPY_FEEDBACK_MS = 1_500;

export interface CopyIconButtonProps {
  /** The text placed on the clipboard. */
  value: string;
  /** Stable accessible name, e.g. "Copy session path". */
  label: string;
  /** Tooltip while idle; defaults to `label`. */
  title?: string;
  /** Test handle on the button (the live region is inside it). */
  testId?: string;
  className?: string;
}

export function CopyIconButton({
  value,
  label,
  title,
  testId,
  className,
}: CopyIconButtonProps): React.JSX.Element {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const run = (): void => {
    void copyText(value).then((copied) => {
      setStatus(copied ? "copied" : "failed");
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setStatus("idle"), COPY_FEEDBACK_MS);
    });
  };

  const Icon = status === "copied" ? Check : status === "failed" ? X : Copy;
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-label={label}
      title={
        status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : (title ?? label)
      }
      className={cn(
        status === "copied" && "text-ok",
        status === "failed" && "text-danger",
        className,
      )}
      disabled={value.length === 0}
      data-testid={testId}
      onClick={run}
    >
      <Icon className="size-3" aria-hidden />
      <span className="sr-only" aria-live="polite">
        {status === "copied"
          ? `${label}: copied`
          : status === "failed"
            ? `${label}: copy failed`
            : ""}
      </span>
    </Button>
  );
}
