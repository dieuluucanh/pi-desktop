import {
  buildContributionBar,
  contributionKey,
  type ContributionSnapshot,
  type ContributionView,
} from "../../../shared/extension-contributions-view";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { contributionTextClass } from "./contribution-tone";

/**
 * Generic extension contribution bar (orchestrator plan steps 9 and 11).
 *
 * This component knows nothing about any extension. It renders whatever the
 * host registry published: one badge, status/progress rows, actions naming a
 * registered command, input availability, and a host-provided linked tab. An
 * arbitrary third-party extension gets the same UI, which is the point of the
 * generic contract.
 *
 * Actions are presentational: `onRunAction` forwards `(ownerId, id)` and the
 * host re-validates the command, provenance and enabled state before running
 * it. A long action list keeps the first few inline and folds the rest into a
 * menu, so a verbose publisher cannot take over the column.
 */

/** Actions shown inline before the overflow menu takes over. */
const INLINE_ACTION_LIMIT = 4;

export interface ContributionsBarProps {
  snapshot: ContributionSnapshot | undefined;
  onRunAction: (ownerId: string, id: string) => void;
  /**
   * False when the composer already renders the same badge (the mode is named
   * in the input box); the rows and controls still render here.
   */
  showBadge?: boolean;
  /**
   * A host-known web tab linked to this session. Generic: the bar only draws a
   * button, the host decides which tab (if any) that is.
   */
  linkedTab?: { label: string; onOpen: () => void } | null;
  className?: string;
}

function Row({ entry }: { entry: ContributionView }) {
  return (
    <div
      data-testid="contribution-row"
      data-kind={entry.kind}
      data-owner={entry.ownerId}
      className="min-w-0 truncate"
      title={entry.detail ?? entry.text}
    >
      <span className={contributionTextClass(entry.tone)}>{entry.text}</span>
      {entry.kind === "progress" && entry.done !== undefined && entry.total !== undefined ? (
        <span className="ml-1 text-ink-faint">
          {entry.done}/{entry.total}
          {entry.detail ? ` · ${entry.detail}` : ""}
          {entry.stale ? " ⚠" : ""}
        </span>
      ) : null}
    </div>
  );
}

function ActionButton({
  entry,
  onRunAction,
}: {
  entry: ContributionView;
  onRunAction: (ownerId: string, id: string) => void;
}) {
  return (
    <Button
      size="sm"
      variant="secondary"
      data-testid="contribution-action"
      data-owner={entry.ownerId}
      disabled={!entry.enabled}
      title={entry.disabledReason ?? entry.command?.name ?? entry.text}
      onClick={() => onRunAction(entry.ownerId, entry.id)}
    >
      {entry.text}
    </Button>
  );
}

export function ContributionsBar({
  snapshot,
  onRunAction,
  showBadge = true,
  linkedTab = null,
  className,
}: ContributionsBarProps) {
  if (!snapshot || snapshot.contributions.length === 0) return null;
  const bar = buildContributionBar(snapshot);
  const inline = bar.actions.slice(0, INLINE_ACTION_LIMIT);
  const overflow = bar.actions.slice(INLINE_ACTION_LIMIT);
  // `available` is the normal case and needs no chrome; a restricted/locked
  // input is the state the user has to understand.
  const inputStates = bar.inputs.filter((entry) => entry.availability !== "available");
  return (
    <div
      data-testid="contributions-bar"
      data-supported={snapshot.supported ? "true" : "false"}
      role="group"
      aria-label="Extension contributions"
      className={
        className ??
        "flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-surface px-3 py-1 text-xs"
      }
    >
      {showBadge && bar.badge ? (
        <div
          data-testid="contribution-badge"
          data-owner={bar.badge.ownerId}
          data-kind={bar.badge.kind}
          data-tone={bar.badge.tone}
          className={`shrink-0 font-medium ${contributionTextClass(bar.badge.tone)}`}
          title={bar.badge.detail ?? bar.badge.text}
        >
          {bar.badge.text}
        </div>
      ) : null}
      {bar.rows.length > 0 ? (
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {bar.rows.map((entry) => (
            <Row key={contributionKey(entry)} entry={entry} />
          ))}
        </div>
      ) : (
        <div className="flex-1" />
      )}
      {inputStates.map((entry) => (
        <span
          key={contributionKey(entry)}
          data-testid="contribution-input"
          data-availability={entry.availability ?? entry.text}
          className={`shrink-0 ${contributionTextClass(entry.tone)}`}
          title={entry.detail ?? entry.text}
        >
          {entry.availability === "locked" ? "input locked" : "input restricted"}
        </span>
      ))}
      <div className="flex shrink-0 items-center gap-1">
        {linkedTab ? (
          <Button
            size="sm"
            variant="secondary"
            data-testid="contribution-linked-tab"
            onClick={linkedTab.onOpen}
          >
            {linkedTab.label}
          </Button>
        ) : null}
        {inline.map((entry) => (
          <ActionButton key={contributionKey(entry)} entry={entry} onRunAction={onRunAction} />
        ))}
        {overflow.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" data-testid="contribution-action-overflow">
                More…
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuLabel>Extension actions</DropdownMenuLabel>
              {overflow.map((entry) => (
                <DropdownMenuItem
                  key={contributionKey(entry)}
                  disabled={!entry.enabled}
                  title={entry.disabledReason ?? entry.command?.name ?? entry.text}
                  onSelect={() => onRunAction(entry.ownerId, entry.id)}
                >
                  {entry.text}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}
