import { SquareTerminal } from "lucide-react";

import { useAppStore } from "../state/app-store";
import { Button } from "../ui/button";
import { TerminalProfileMenu } from "./TerminalProfileMenu";

/**
 * The joined New Terminal control (2026-11-05 terminal follow-up plan).
 *
 * One bounded chip with two segments: the terminal icon opens the default
 * shell, and the chevron opens the one-off profile menu. The outer chip owns
 * the border and divider; the two segments keep their own accessible names so
 * keyboard and screen-reader users still get two distinct actions. There is no
 * `overflow-hidden` here: the global focus outline must stay visible.
 */
export function TerminalSplitButton(): React.JSX.Element {
  const createSessionTab = useAppStore((state) => state.createSessionTab);

  return (
    <div
      role="group"
      aria-label="Terminal actions"
      data-testid="terminal-split-button"
      className="inline-flex shrink-0 items-center rounded-xs border border-line"
    >
      <Button
        size="icon-sm"
        variant="ghost"
        className="h-6 w-6 rounded-l-xs rounded-r-none border-0"
        aria-label="New terminal"
        title="New terminal (Ctrl+Shift+T)"
        onClick={() => void createSessionTab("terminal")}
      >
        <SquareTerminal className="size-3.5" aria-hidden />
      </Button>
      <span aria-hidden className="h-3 w-px shrink-0 bg-line" />
      <TerminalProfileMenu triggerClassName="h-6 w-5 rounded-l-none rounded-r-xs border-0 px-0" />
    </div>
  );
}
