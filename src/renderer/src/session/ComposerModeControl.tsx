import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ContributionModeAction,
  ContributionView,
} from "../../../shared/extension-contributions-view";
import { cn } from "../ui/cn";
import { contributionTextClass } from "./contribution-tone";

/**
 * The composer's current-mode control (2026-11-22 mode-cycle plan, step 7).
 *
 * It is both an informative label and — when the publisher referenced a live
 * same-owner action — a real button that advances the mode. The visible text is
 * always the *published* mode, never an optimistic local step: the host owns the
 * cycle, and a new contribution snapshot is what moves the label.
 *
 * The pointer path deliberately keeps focus in the prompt (`pointerdown` is
 * default-prevented), so clicking the control cannot move the caret, drop the
 * selection or clear the draft. Keyboard users can Tab to the button and press
 * Enter/Space, exactly like any other button.
 */

/** Reservation used before the control can be measured (and in jsdom). */
export const DEFAULT_MODE_CONTROL_WIDTH_PX = 56;
/** Upper bound for the reserved width; longer labels truncate visually. */
export const MAX_MODE_CONTROL_WIDTH_PX = 240;

export interface ComposerModeControlProps {
  /** The primary mode contribution, or null when the publisher has none. */
  mode: ContributionView | null;
  /** The mode's resolved activation, or null for a non-interactive label. */
  action: ContributionModeAction | null;
  /** The buffer is a `!` shell command: its warning tone wins. */
  bashMode?: boolean;
  /**
   * Runs the referenced action through the existing contribution runner.
   * Resolves true when the host acknowledged an error-free invocation; the
   * label follows the next snapshot, not this result.
   */
  onRunAction?: (ownerId: string, id: string) => Promise<boolean>;
  /** Reports the rendered width so the composer can reserve space for it. */
  onMeasure?: (widthPx: number) => void;
}

export function ComposerModeControl({
  mode,
  action,
  bashMode = false,
  onRunAction,
  onMeasure,
}: ComposerModeControlProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const [pending, setPending] = useState(false);

  // Reserve the real width instead of a fixed `pr-14`: "Orchestrator" and
  // localized labels are wider, and a fixed pad both covered text and wasted
  // space on short ones. A missing ResizeObserver (jsdom) keeps the default.
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const report = (): void => {
      const width = Math.ceil(node.getBoundingClientRect().width);
      if (width > 0) onMeasure?.(width);
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [onMeasure]);

  const run = useCallback(async () => {
    if (!mode || !action || !onRunAction) return;
    if (pending || !action.enabled) return;
    setPending(true);
    try {
      await onRunAction(action.ownerId, action.id);
    } finally {
      setPending(false);
    }
  }, [mode, action, onRunAction, pending]);

  if (!mode) return null;

  const label = mode.text;
  const toneClass = bashMode ? "text-warn" : contributionTextClass(mode.tone);
  const shared =
    "max-w-full truncate rounded-xs bg-sunken/90 px-1 text-[10px] font-medium leading-4";

  return (
    <span
      ref={rootRef}
      data-testid="composer-contribution-badge"
      data-tone={mode.tone}
      data-owner={mode.ownerId}
      data-actionable={action ? "true" : "false"}
      className="pointer-events-none absolute right-1.5 top-1 z-10 flex max-w-[min(15rem,50%)] select-none items-center"
    >
      {action ? (
        <button
          type="button"
          data-testid="composer-mode-button"
          data-mode-label="true"
          // The accessible name carries both the current mode and what happens.
          aria-label={`${label} — ${action.text}`}
          title={action.disabledReason ?? action.text}
          disabled={!action.enabled || pending}
          // Keep the prompt's focus, selection and caret on a pointer click;
          // keyboard activation still focuses the button normally.
          onPointerDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault();
            void run();
          }}
          className={cn(
            shared,
            "pointer-events-auto",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-strong",
            "disabled:cursor-not-allowed disabled:opacity-60",
            toneClass,
          )}
        >
          {label}
        </button>
      ) : (
        // A legacy/nonactionable mode stays informative without pretending to
        // be a control.
        <span
          data-testid="composer-mode-label"
          title={mode.detail ?? label}
          className={cn(shared, toneClass)}
        >
          {label}
        </span>
      )}
      {/*
        One polite announcement for actual mode-label changes. It lives outside
        the button so a button's own name is not announced twice, and it does
        not subscribe to progress/status updates.
      */}
      <span role="status" aria-live="polite" className="sr-only">
        {label}
      </span>
    </span>
  );
}
