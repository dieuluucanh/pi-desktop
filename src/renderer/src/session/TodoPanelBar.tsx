import { Ellipsis, ListTodo } from "lucide-react";
import { useState } from "react";

import {
  todoPanelActions,
  todoPanelToggle,
  type TodoPanelActionId,
  type TodoPanelSnapshot,
} from "../../../shared/workflow-todos";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/**
 * The native control strip for the extension-owned todo panel
 * (2026-11-18 todo-panel-all-states plan, step 4).
 *
 * The panel itself is a read-only TUI frame; this bar is the clickable,
 * keyboard-accessible control. It stays mounted when the list is hidden, so
 * “Hide” is never a one-way door. The four actions map one-to-one to the
 * extension's `/todos auto|expand|collapse|hide`; the toggle mirrors
 * `Ctrl+Alt+O` in terminal Pi (the desktop chord is owned by the menu).
 *
 * Presentational only: the caller dispatches the command and restores focus.
 */

export interface TodoPanelBarProps {
  panel: TodoPanelSnapshot;
  onAction: (action: TodoPanelActionId) => void | Promise<void>;
  className?: string;
}

function stateLabel(state: TodoPanelSnapshot["state"]): string | null {
  if (!state) return null;
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function summaryText(panel: TodoPanelSnapshot): string {
  const parts = ["Todos"];
  if (panel.done !== null && panel.total !== null) parts.push(`${panel.done}/${panel.total}`);
  if (panel.cancelled !== null && panel.cancelled > 0) parts.push(`${panel.cancelled} cancelled`);
  if (panel.settled === true) parts.push("all done");
  const state = stateLabel(panel.state);
  if (state) parts.push(state.toLowerCase());
  if (panel.stale) parts.push("stale");
  return parts.join(" · ");
}

export function TodoPanelBar({ panel, onAction, className }: TodoPanelBarProps) {
  const [pending, setPending] = useState<TodoPanelActionId | null>(null);
  const actions = todoPanelActions(panel);
  const toggle = todoPanelToggle(panel);
  const summary = summaryText(panel);

  const run = async (action: TodoPanelActionId): Promise<void> => {
    if (pending !== null) return;
    setPending(action);
    try {
      await onAction(action);
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      data-testid="todo-panel-bar"
      data-state={panel.state ?? "unknown"}
      data-done={panel.done ?? undefined}
      data-total={panel.total ?? undefined}
      data-settled={panel.settled === true ? "true" : undefined}
      data-stale={panel.stale ? "true" : undefined}
      role="region"
      aria-label="Todo panel controls"
      className={cn(
        "flex shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-1 text-[11px]",
        className,
      )}
    >
      <ListTodo
        className={cn(
          "size-3.5 shrink-0",
          panel.settled === true ? "text-ok" : panel.stale ? "text-warn" : "text-ink-faint",
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1 truncate" title={summary}>
        <span className="font-medium text-ink">Todos</span>
        {panel.done !== null && panel.total !== null ? (
          <span className="ml-1 tabular-nums text-ink-muted">
            {panel.done}/{panel.total}
          </span>
        ) : null}
        {panel.cancelled !== null && panel.cancelled > 0 ? (
          <span className="ml-1 text-ink-faint">· {panel.cancelled} cancelled</span>
        ) : null}
        {panel.settled === true ? <span className="ml-1 text-ok">· all done</span> : null}
        {stateLabel(panel.state) ? (
          <span className="ml-1 text-ink-faint">· {stateLabel(panel.state)}</span>
        ) : null}
        {panel.stale ? (
          <span className="ml-1 text-warn" title="The todo list was not updated this run">
            ⚠
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={pending !== null}
          aria-label={toggle.description}
          title={toggle.description}
          data-testid="todo-panel-bar-toggle"
          onClick={() => void run(toggle.action)}
        >
          {pending === toggle.action ? "…" : toggle.label}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Todo panel options"
              title="Todo panel options (Ctrl+Alt+L toggles in the desktop)"
              data-testid="todo-panel-bar-menu"
              disabled={pending !== null}
            >
              <Ellipsis className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuLabel>Todo panel</DropdownMenuLabel>
            {actions.map((action) => (
              <DropdownMenuItem
                key={action.id}
                disabled={action.disabled || pending !== null}
                title={action.description}
                data-testid={`todo-panel-action-${action.id}`}
                onSelect={() => void run(action.id)}
              >
                <span className="flex-1">{action.label}</span>
                {action.id === "auto" ? (
                  <span className="text-[10px] text-ink-faint">default</span>
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
