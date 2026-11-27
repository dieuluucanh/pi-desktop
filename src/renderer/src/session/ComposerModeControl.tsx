import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronUp } from "lucide-react";
import type {
  ContributionModeAction,
  ContributionModeChoice,
  ContributionView,
} from "../../../shared/extension-contributions-view";
import { cn } from "../ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { contributionTextClass } from "./contribution-tone";

/**
 * The composer's current-mode control (2026-11-22 mode-cycle plan, step 7;
 * split into label + menu by the 2026-11-25 working-bar plan, step 5).
 *
 * It is both an informative label and — when the publisher referenced a live
 * same-owner action — a real button that advances the mode. The visible text is
 * always the *published* mode, never an optimistic local step: the host owns the
 * cycle, and a new contribution snapshot is what moves the label.
 *
 * When the publisher also supplies same-owner `mode-choice` entries, a chevron
 * on the label's right opens an upward list of modes. The choices are menu data
 * only: the referenced action owns execution, so selecting one runs the same
 * `contributions.run` path as any other action and the label still waits for
 * the next snapshot. No choices means no chevron, so a legacy publisher keeps
 * the exact label/cycle behaviour it had.
 *
 * The pointer path of the *label* deliberately keeps focus in the prompt
 * (`pointerdown` is default-prevented), so clicking it cannot move the caret,
 * drop the selection or clear the draft. Keyboard users can Tab to the button
 * and press Enter/Space, exactly like any other button. The chevron is a normal
 * Radix trigger: opening a menu legitimately moves focus into it.
 */

/** Reservation used before the control can be measured (and in jsdom). */
export const DEFAULT_MODE_CONTROL_WIDTH_PX = 56;
/** Upper bound for the reserved width; longer labels truncate visually. */
export const MAX_MODE_CONTROL_WIDTH_PX = 240;

/** What a menu row announces/disables with: the referenced action owns state. */
export interface ModeChoiceItem {
  choice: ContributionView;
  action: ContributionModeAction | null;
  checked: boolean;
  disabled: boolean;
  /** Disabled reason, action label, or the publisher's description. */
  title: string;
}

/**
 * Pure presentation for the menu, so the checked/disabled rules are testable
 * without depending on Radix's portal rendering.
 *
 * The current mode is checked and disabled; a choice with no resolvable
 * same-owner action (dangling, cross-owner, wrong-kind or missing) or with a
 * disabled action is disabled with its reason. Nothing here runs a command.
 */
function modeChoiceItems(choices: readonly ContributionModeChoice[]): ModeChoiceItem[] {
  return choices.map(({ choice, action }) => {
    const checked = choice.checked === true;
    const disabled = checked || action === null || !action.enabled;
    const title = checked
      ? (action?.disabledReason ?? action?.text ?? "Current mode")
      : action === null
        ? (choice.detail ?? `${choice.text} is not available from this publisher`)
        : (action.disabledReason ?? action.text);
    return { choice, action, checked, disabled, title };
  });
}

export interface ComposerModeControlProps {
  /** The primary mode contribution, or null when the publisher has none. */
  mode: ContributionView | null;
  /** The mode's resolved activation, or null for a non-interactive label. */
  action: ContributionModeAction | null;
  /**
   * Same-owner `mode-choice` entries for the direct menu. Empty for a legacy
   * publisher, which keeps the label/cycle control without a chevron.
   */
  choices?: readonly ContributionModeChoice[];
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
  choices = [],
  bashMode = false,
  onRunAction,
  onMeasure,
}: ComposerModeControlProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const [pending, setPending] = useState(false);

  const hasChoices = choices.length > 0;
  const items = modeChoiceItems(choices);

  // Reserve the *whole* control's width (label + chevron), not just the label:
  // the first prompt line has to clear both. `onMeasure` runs on the measured
  // root below instead of a fixed `pr-14`: "Orchestrator" and localized labels
  // are wider, and a fixed pad both covered text and wasted space on short ones.
  // A missing ResizeObserver (jsdom) keeps the default; `hasChoices` re-reports
  // when a later snapshot adds the chevron.
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
  }, [onMeasure, hasChoices]);

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

  const runChoice = useCallback(
    async (choiceAction: ContributionModeAction) => {
      if (pending || !choiceAction.enabled || !onRunAction) return;
      setPending(true);
      try {
        await onRunAction(choiceAction.ownerId, choiceAction.id);
      } finally {
        setPending(false);
      }
    },
    [onRunAction, pending],
  );

  if (!mode) return null;

  const label = mode.text;
  const toneClass = bashMode ? "text-warn" : contributionTextClass(mode.tone);
  const shared =
    "max-w-full min-w-0 truncate rounded-xs bg-sunken/90 px-1 text-[10px] font-medium leading-4";

  return (
    <span
      ref={rootRef}
      data-testid="composer-contribution-badge"
      data-tone={mode.tone}
      data-owner={mode.ownerId}
      data-actionable={action ? "true" : "false"}
      data-choices={hasChoices ? "true" : "false"}
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
      {hasChoices ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/*
              A separate trigger, not part of the cycle button: the label keeps
              its one-click cycle (and its pointer-focus rule), while this uses
              Radix's normal roving focus. It stays usable when the cycle action
              itself is disabled (Review), so the menu reasons are readable.
            */}
            <button
              type="button"
              aria-label="Switch mode"
              aria-haspopup="menu"
              data-testid="composer-mode-menu"
              title="Switch mode"
              className={cn(
                "pointer-events-auto flex h-4 shrink-0 items-center rounded-xs bg-sunken/90 pl-0.5 pr-1 text-ink-muted",
                "hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-strong",
              )}
            >
              <ChevronUp className="size-3" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="end"
            data-testid="composer-mode-menu-content"
            className="min-w-44"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>Modes</DropdownMenuLabel>
              {items.map((item) => (
                <DropdownMenuItem
                  key={`${item.choice.ownerId}:${item.choice.id}`}
                  role="menuitemradio"
                  aria-checked={item.checked}
                  aria-label={item.choice.text}
                  title={item.title}
                  disabled={item.disabled || pending}
                  data-testid={`composer-mode-choice-${item.choice.id}`}
                  data-checked={item.checked ? "true" : undefined}
                  onSelect={() => {
                    if (item.disabled || item.action === null) return;
                    void runChoice(item.action);
                  }}
                  className={cn(
                    "min-w-0",
                    item.checked && "bg-raised text-accent",
                    !item.disabled && "cursor-pointer",
                  )}
                >
                  {item.checked ? (
                    <Check className="size-3.5 shrink-0" aria-hidden />
                  ) : (
                    <span className="size-3.5 shrink-0" aria-hidden />
                  )}
                  <span className="min-w-0 truncate">{item.choice.text}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
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
