import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { cn } from "../ui/cn";

/**
 * The transcript find bar (2026-10-26 session-parity plan step 11).
 *
 * Terminal Pi opens its alt-screen search with `ctrl+f`/`ctrl+shift+f` and walks
 * matches with next/prev. The bar owns only the controls: the matcher is a pure
 * item-model function in `transcript-search.ts`, so this works on a virtualized
 * transcript where most rows are not in the DOM.
 */
export function TranscriptFindBar({
  query,
  onQueryChange,
  regex,
  onToggleRegex,
  count,
  activeIndex,
  error,
  onNext,
  onPrev,
  onClose,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  regex: boolean;
  onToggleRegex: () => void;
  count: number;
  activeIndex: number;
  error: string | null;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const position = count === 0 ? 0 : Math.min(activeIndex + 1, count);

  return (
    <div
      data-testid="transcript-find"
      className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-sm border border-line bg-surface px-2 py-1 shadow-sm"
      role="search"
    >
      <input
        ref={inputRef}
        aria-label="Find in transcript"
        className={cn(
          "w-48 bg-transparent text-xs outline-none placeholder:text-ink-faint",
          error && "text-danger",
        )}
        placeholder="Find in transcript"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) onPrev();
            else onNext();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <button
        type="button"
        aria-pressed={regex}
        aria-label="Regular expression"
        title="Match with a regular expression"
        className={cn(
          "rounded-xs px-1 font-mono text-[11px]",
          regex ? "bg-accent/20 text-accent" : "text-ink-faint hover:text-ink",
        )}
        onClick={onToggleRegex}
      >
        .*
      </button>
      <span
        className="min-w-12 text-center text-[11px] text-ink-muted"
        aria-live="polite"
        data-testid="transcript-find-count"
      >
        {error ? "invalid" : count === 0 ? "no results" : `${position}/${count}`}
      </span>
      <button
        type="button"
        aria-label="Previous match"
        title="Shift+Enter"
        className="rounded-xs p-0.5 text-ink-muted hover:text-ink"
        onClick={onPrev}
        disabled={count === 0}
      >
        <ChevronUp className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Next match"
        title="Enter"
        className="rounded-xs p-0.5 text-ink-muted hover:text-ink"
        onClick={onNext}
        disabled={count === 0}
      >
        <ChevronDown className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Close find"
        title="Esc"
        className="rounded-xs p-0.5 text-ink-muted hover:text-ink"
        onClick={onClose}
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
