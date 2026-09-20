/**
 * The completion overlay (plan step 7).
 *
 * Purely presentational: the composer owns the textarea, the caret and the
 * keyboard, so this list only shows what the provider returned and reports
 * hover/pick. Each row carries its **source**, which is what makes a name
 * collision visible instead of silently shadowed.
 */

import type { CompletionItem, CompletionSource } from "./types";
import { cn } from "../ui/cn";

export interface CompletionOverlayProps {
  items: readonly CompletionItem[];
  activeIndex: number;
  /** True when the workspace listing was capped, so the list is partial. */
  truncated?: boolean;
  onHover: (index: number) => void;
  onPick: (item: CompletionItem) => void;
}

const SOURCE_LABEL: Record<CompletionSource, string> = {
  app: "app",
  extension: "extension",
  prompt: "prompt",
  skill: "skill",
  file: "file",
  document: "doc",
};

export function CompletionOverlay({
  items,
  activeIndex,
  truncated = false,
  onHover,
  onPick,
}: CompletionOverlayProps) {
  if (items.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label="Completions"
      data-testid="completion-overlay"
      className="mb-2 max-h-56 overflow-y-auto rounded-sm border border-line bg-raised shadow-lg"
    >
      {items.map((item, index) => {
        const active = index === activeIndex;
        return (
          <button
            key={`${item.source ?? "item"}:${item.value}:${index}`}
            type="button"
            role="option"
            aria-selected={active}
            onMouseEnter={() => onHover(index)}
            // `onMouseDown` rather than `onClick`: the textarea must not lose the
            // caret (and therefore the token being completed) before the pick.
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(item);
            }}
            className={cn(
              "flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs",
              active ? "bg-accent/15 text-ink" : "text-ink-faint hover:bg-raised/60",
            )}
          >
            <span className="truncate font-medium">{item.label}</span>
            {item.source ? (
              <span className="shrink-0 rounded-xs border border-line px-1 text-[10px] uppercase tracking-wide">
                {SOURCE_LABEL[item.source]}
              </span>
            ) : null}
            {item.detail ? (
              <span className="shrink-0 text-[10px] text-ink-faint">{item.detail}</span>
            ) : null}
            {item.description ? (
              <span className="ml-auto truncate pl-2 text-[11px] text-ink-faint">
                {item.description}
              </span>
            ) : null}
          </button>
        );
      })}
      {truncated ? (
        <p className="border-t border-line px-2 py-1 text-[10px] text-ink-faint">
          More files exist than are listed — keep typing to narrow the list.
        </p>
      ) : null}
    </div>
  );
}
