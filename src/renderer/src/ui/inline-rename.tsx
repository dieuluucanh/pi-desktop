/**
 * File-explorer-style inline rename (2026-10-31 UI plan).
 *
 * Enter or blur commits, Escape cancels, and an empty value cancels. The input
 * selects its text on mount and records whether it has settled so Enter's
 * follow-up blur cannot commit twice.
 */

import { useEffect, useRef, useState } from "react";

import { cn } from "./cn";

export interface InlineRenameProps {
  value: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  ariaLabel: string;
  className?: string;
  maxLength?: number;
}

export function InlineRename({
  value,
  onCommit,
  onCancel,
  ariaLabel,
  className,
  maxLength = 200,
}: InlineRenameProps) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const settled = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const commit = (): void => {
    if (settled.current) return;
    settled.current = true;
    const next = draft.trim();
    if (next.length === 0) onCancel();
    else onCommit(next);
  };

  const cancel = (): void => {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      aria-label={ariaLabel}
      value={draft}
      maxLength={maxLength}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
      className={cn(
        "h-6 min-w-0 rounded-xs border border-line bg-raised px-1 text-xs text-ink outline-none focus:border-accent",
        className,
      )}
    />
  );
}
