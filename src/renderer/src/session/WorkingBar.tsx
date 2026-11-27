import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, MoreVertical } from "lucide-react";

import type { ExtensionWorkingState } from "../../../shared/extension-ui";
import {
  contributionKey,
  type ContributionBarModel,
  type ContributionView,
} from "../../../shared/extension-contributions-view";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/**
 * The single working/status bar (2026-11-25 session run bar plan, step 3).
 *
 * One thin row directly above the composer. It is presentational: everything it
 * draws comes from props — the resolved `ContributionBarModel`, the extension
 * `working` state, the run clock and a host-provided linked tab. It knows no
 * extension name, glyph or command.
 *
 * Semantics the row must keep:
 * - A spinner (`working.frames`, else the app's pulsing marker), the extension
 *   working message (verbatim, clamped to one line, full text in `title` plus a
 *   visually hidden `role="status"` node), the elapsed time and the default
 *   `Esc to cancel` hint. The hint appears ONLY when the extension published no
 *   working message; a message is the hint and is never appended to.
 * - `working.visible === false` and `frames: []` hide only the indicator and
 *   message. Actions, the menu and the input-lock indicator stay, because
 *   “hide the spinner” is not “remove the extension's controls”.
 * - Idle with only menu actions shows the first menu group's label (e.g.
 *   `Todos`) instead of mirroring progress counts, so the three-dot trigger is
 *   not an orphan.
 * - Actions are `xs` buttons/menu items. `onRunAction` forwards `(ownerId, id)`
 *   and the host re-validates provenance, enabled state and the command. A
 *   local pending guard keeps a double click from dispatching twice.
 * - The row renders nothing when there is genuinely nothing to show: no
 *   visible status, no idle group label, no action, no linked tab, no menu and
 *   no input lock.
 */

export interface WorkingBarProps {
  /** The extension's working state for this tab (never undefined). */
  working: ExtensionWorkingState;
  /** Whether the tab's turn is running; the default `Working…` needs it. */
  running?: boolean;
  /** Epoch ms when the run started; elapsed time renders when present. */
  startedAt?: number | null;
  /** One deterministic model resolved by `buildContributionBar()`. */
  model: ContributionBarModel;
  /** A host-known web tab linked to this session; the bar only draws a button. */
  linkedTab?: { label: string; onOpen: () => void } | null;
  onRunAction: (ownerId: string, id: string) => void | Promise<unknown>;
  className?: string;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

/**
 * The accessible/tooltip description of an action. A disabled action's reason
 * always wins so the user can read why the control does nothing.
 */
function actionDescription(entry: ContributionView): string | undefined {
  if (!entry.enabled) return entry.disabledReason ?? entry.detail;
  return entry.detail ?? entry.command?.name;
}

function ActionButton({
  entry,
  pending,
  onRun,
}: {
  entry: ContributionView;
  pending: boolean;
  onRun: (entry: ContributionView) => void;
}) {
  const description = actionDescription(entry);
  return (
    <Button
      size="xs"
      variant="secondary"
      data-testid="working-bar-action"
      data-owner={entry.ownerId}
      data-id={entry.id}
      disabled={!entry.enabled || pending}
      title={description ?? entry.text}
      aria-description={description}
      onClick={() => onRun(entry)}
    >
      <span className="max-w-40 truncate">{entry.text}</span>
    </Button>
  );
}

export function WorkingBar({
  working,
  running = false,
  startedAt = null,
  model,
  linkedTab = null,
  onRunAction,
  className,
}: WorkingBarProps) {
  const frames = working.frames;
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // A ref (not just state) guards the synchronous double-dispatch window: two
  // clicks in one batch would both read the pre-update state.
  const pendingRef = useRef(false);

  useEffect(() => {
    if (!frames || frames.length <= 1) return;
    const interval = setInterval(() => {
      setFrame((value) => (value + 1) % frames.length);
    }, working.intervalMs ?? 100);
    return () => clearInterval(interval);
  }, [frames, working.intervalMs]);

  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const runAction = useCallback(
    (entry: ContributionView) => {
      if (pendingRef.current || !entry.enabled) return;
      const key = contributionKey(entry);
      pendingRef.current = true;
      setPendingKey(key);
      void (async () => {
        try {
          await onRunAction(entry.ownerId, entry.id);
        } finally {
          pendingRef.current = false;
          setPendingKey(null);
        }
      })();
    },
    [onRunAction],
  );

  // `visible:false` and empty `frames` describe the indicator only. The bar
  // itself stays as long as it has another control to show.
  const indicatorVisible = working.visible !== false && !(frames !== null && frames.length === 0);
  const message =
    working.message !== null && working.message.trim().length > 0 ? working.message : null;
  const showIndicator = indicatorVisible && (message !== null || running);
  const marker = frames && frames.length > 0 ? (frames[frame % frames.length] ?? "") : "●";
  const elapsed = startedAt === null ? null : formatElapsed(now - startedAt);
  // The default hint is the fallback for a plain run. An extension message is
  // the hint and is never appended to.
  const showCancelHint = showIndicator && message === null && running;
  const idleGroupLabel =
    !showIndicator && model.inlineActions.length === 0
      ? (model.actionGroups[0]?.label ?? null)
      : null;

  // `locked` is the only state the bar marks: `available` is the normal case
  // and `restricted` still accepts prose, so neither needs chrome here.
  const inputLock = model.inputs.find((entry) => entry.availability === "locked") ?? null;
  const lockReason = inputLock === null ? null : (inputLock.detail ?? inputLock.text);

  const hasMenu = model.actionGroups.length > 0 || model.overflowActions.length > 0;
  if (
    !showIndicator &&
    idleGroupLabel === null &&
    model.inlineActions.length === 0 &&
    !linkedTab &&
    !hasMenu &&
    inputLock === null
  ) {
    return null;
  }

  const menuItem = (entry: ContributionView) => {
    const description = actionDescription(entry);
    return (
      <DropdownMenuItem
        key={contributionKey(entry)}
        data-testid={`working-bar-menu-item-${contributionKey(entry)}`}
        data-owner={entry.ownerId}
        data-id={entry.id}
        disabled={!entry.enabled || pendingKey !== null}
        title={description ?? entry.text}
        aria-description={description}
        onSelect={() => runAction(entry)}
      >
        <span className="min-w-0 truncate">{entry.text}</span>
      </DropdownMenuItem>
    );
  };

  return (
    <div
      data-testid="working-bar"
      className={cn(
        "flex h-7 shrink-0 items-center gap-2 overflow-hidden border-t border-line bg-surface px-3 text-[11px] text-ink-muted",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {showIndicator ? (
          <>
            <span
              data-testid="working-bar-indicator"
              aria-hidden
              className={cn(
                "shrink-0",
                frames && frames.length > 0 ? "font-mono" : "animate-pulse text-accent",
              )}
            >
              {marker}
            </span>
            <span
              data-testid="working-bar-message"
              className="min-w-0 truncate text-ink-muted"
              title={message ?? undefined}
            >
              {message ?? "Working…"}
            </span>
            {elapsed === null ? null : (
              <span data-testid="working-bar-elapsed" className="shrink-0 text-ink-subtle">
                {elapsed}
              </span>
            )}
            {showCancelHint ? (
              <span data-testid="working-bar-hint" className="shrink-0 text-ink-subtle">
                Esc to cancel
              </span>
            ) : null}
            {/* Full, untruncated message for assistive tech. The elapsed value
                is deliberately outside this live region: it ticks every second
                and must not be announced. */}
            {message === null ? null : (
              <span role="status" data-testid="working-bar-status" className="sr-only">
                {message}
              </span>
            )}
          </>
        ) : idleGroupLabel === null ? null : (
          <span data-testid="working-bar-group-label" className="min-w-0 truncate text-ink-faint">
            {idleGroupLabel}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {inputLock === null ? null : (
          <span
            data-testid="working-bar-input-lock"
            role="img"
            aria-label={`Input locked: ${lockReason ?? inputLock.text}`}
            title={lockReason ?? inputLock.text}
            className="flex shrink-0 items-center text-warn"
          >
            <Lock className="size-3" aria-hidden />
          </span>
        )}
        {linkedTab ? (
          <Button
            size="xs"
            variant="secondary"
            data-testid="working-bar-linked-tab"
            onClick={linkedTab.onOpen}
          >
            <span className="max-w-40 truncate">{linkedTab.label}</span>
          </Button>
        ) : null}
        {model.inlineActions.map((entry) => (
          <ActionButton
            key={contributionKey(entry)}
            entry={entry}
            pending={pendingKey !== null}
            onRun={runAction}
          />
        ))}
        {hasMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="More actions"
                title="More actions"
                data-testid="working-bar-menu"
              >
                <MoreVertical className="size-3.5" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="min-w-44">
              {model.actionGroups.map((group) => (
                <DropdownMenuGroup key={`${group.ownerId}:${group.id}`}>
                  <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                  {group.actions.map(menuItem)}
                </DropdownMenuGroup>
              ))}
              {model.overflowActions.length === 0 ? null : (
                <DropdownMenuGroup>
                  <DropdownMenuLabel>More actions</DropdownMenuLabel>
                  {model.overflowActions.map(menuItem)}
                </DropdownMenuGroup>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}
