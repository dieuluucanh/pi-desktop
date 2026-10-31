/**
 * The thinking-level picker (plan step 8).
 *
 * The levels come from the host's `thinking.levels`, which Pi derives from the
 * current model (`getAvailableThinkingLevels()`), so the list can never offer a
 * level the model does not support — the clamping is Pi's, not a second rule
 * invented here. Choosing a level after switching models therefore stays valid,
 * and an empty list is reported as "this model does not support thinking".
 *
 * Picking a level always saves it as the default (the workflow extension
 * records it on `thinking_level_select` when the model is the saved default),
 * so there is no "save as default" switch to forget to tick.
 */

import { Check } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { cn } from "../ui/cn";
import {
  isThinkingLevel,
  orderThinkingLevels,
  THINKING_DESCRIPTIONS,
  thinkingLevelTitle,
} from "../../../shared/thinking";
import { ThinkingLevelIcon } from "./ThinkingLevelIcon";

export interface ThinkingPickerProps {
  open: boolean;
  levels: readonly string[];
  current: string | null;
  /** Full `provider/id` or short id, named in the dialog and row tooltips. */
  modelLabel?: string | null;
  onPick: (level: string, options: { persist: boolean }) => void;
  onClose: () => void;
}

/** Short explanations for the levels Pi uses; unknown levels still render. */

export function ThinkingPicker({
  open,
  levels,
  current,
  modelLabel,
  onPick,
  onClose,
}: ThinkingPickerProps) {
  const ordered = orderThinkingLevels([...levels]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent aria-label="Choose a thinking level">
        <DialogTitle>Thinking level</DialogTitle>
        <DialogDescription>
          {modelLabel
            ? `Levels supported by ${modelLabel}.`
            : "Levels are limited to what the current model supports."}
        </DialogDescription>

        <div className="mt-3" data-testid="thinking-levels">
          {ordered.length === 0 ? (
            <p className="text-xs text-ink-faint">This model does not support thinking levels.</p>
          ) : (
            ordered.map((level) => {
              const active = level === current;
              return (
                <button
                  key={level}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-level={level}
                  title={thinkingLevelTitle(level, ordered, modelLabel)}
                  onClick={() => onPick(level, { persist: true })}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs",
                    active ? "bg-accent/15 text-ink" : "text-ink-faint hover:bg-raised",
                  )}
                >
                  {active ? <Check className="size-3" aria-hidden /> : <span className="size-3" />}
                  <ThinkingLevelIcon level={level} className="shrink-0" />
                  <span className="font-medium">{level}</span>
                  <span className="min-w-0 truncate text-[11px] text-ink-faint">
                    {isThinkingLevel(level) ? THINKING_DESCRIPTIONS[level] : "Custom level"}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="mt-3 flex items-center justify-end border-t border-line pt-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
