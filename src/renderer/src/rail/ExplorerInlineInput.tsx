import { useEffect, useRef, useState } from "react";

import { cn } from "../ui/cn";

export interface ExplorerInlineInputProps {
  value?: string;
  placeholder?: string;
  ariaLabel: string;
  error?: string | null;
  onCommit: (value: string) => boolean | Promise<boolean>;
  onCancel: () => void;
  className?: string;
}

/**
 * Inline create/rename input for the explorer.
 *
 * Unlike the generic `InlineRename`, this stays open when the operation fails
 * and shows the error, so a reserved name or a collision can be corrected
 * without reopening the menu.
 */
export function ExplorerInlineInput({
  value = "",
  placeholder,
  ariaLabel,
  error = null,
  onCommit,
  onCancel,
  className,
}: ExplorerInlineInputProps): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const settled = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    if (value.length > 0) input.select();
  }, [value]);

  const commit = async (): Promise<void> => {
    if (settled.current || pending) return;
    const next = draft.trim();
    if (next.length === 0) {
      settled.current = true;
      onCancel();
      return;
    }
    setPending(true);
    const ok = await Promise.resolve(onCommit(next)).finally(() => setPending(false));
    if (ok) {
      settled.current = true;
      return;
    }
    // Keep the input alive and focused after a failed create/rename.
    queueMicrotask(() => inputRef.current?.focus());
  };

  const cancel = (): void => {
    if (settled.current || pending) return;
    settled.current = true;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      aria-label={ariaLabel}
      value={draft}
      placeholder={placeholder}
      maxLength={255}
      disabled={pending}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
      aria-invalid={error ? true : undefined}
      title={error ?? undefined}
      className={cn(
        "h-6 min-w-0 rounded-xs border bg-raised px-1 text-xs text-ink outline-none",
        error ? "border-danger" : "border-line focus:border-accent",
        className,
      )}
    />
  );
}
