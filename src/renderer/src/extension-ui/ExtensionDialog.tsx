import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { useAppStore } from "../state/app-store";
import type { ExtensionDialogRequest } from "../../../shared/extension-ui";

/**
 * Extension dialogs (plan step 16; inline dock 2026-10-26).
 *
 * In terminal Pi `ctx.ui.select/confirm/input/editor` are **non-overlay**
 * extension dialogs: they replace the editor dock, so the chat stays visible
 * and scrollable. The desktop used to render them as a Radix modal with a dim
 * backdrop; this dock is the Pi-shaped version. It replaces the composer in the
 * session column and owns the keyboard until the extension is answered.
 *
 * Esc cancels, Enter submits (Shift+Enter is a newline in the multi-line
 * editor), the first option/control is focused, and an extension-provided
 * `timeout` shows a live countdown. The timeout itself is enforced by the store
 * (`answerExtensionDialog`), so it still fires while its tab is in the
 * background.
 */

export interface ExtensionDialogDockProps {
  dialog: ExtensionDialogRequest;
  /** The session viewport's height in pixels. */
  maxHeight: number;
  /** Bumped when the session view reclaims the keyboard for this dock. */
  focusToken?: number;
}

export function ExtensionDialogDock({
  dialog,
  maxHeight,
  focusToken = 0,
}: ExtensionDialogDockProps) {
  const answer = useAppStore((state) => state.answerExtensionDialog);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const titleId = `extension-dialog-title-${dialog.id}`;

  const cancel = (): void => {
    void answer(dialog, { cancelled: true });
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (root.contains(document.activeElement)) return;
    const target = root.querySelector<HTMLElement>("[data-autofocus]");
    (target ?? root).focus();
  }, [dialog.id, focusToken]);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-extension-dialog={dialog.id}
      className="flex min-h-0 shrink flex-col overflow-hidden border-t border-accent bg-surface text-ink outline-none"
      style={{ maxHeight }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          cancel();
        }
      }}
    >
      <div className="flex shrink-0 items-start gap-2 px-4 pt-3">
        <h2 id={titleId} className="min-w-0 flex-1 text-sm font-semibold">
          {dialog.title || "Extension"}
        </h2>
        {dialog.timeout ? <DialogCountdown key={`countdown-${dialog.id}`} dialog={dialog} /> : null}
      </div>
      {dialog.method === "confirm" && dialog.message ? (
        <p className="px-4 pb-2 text-xs text-ink-muted">{dialog.message}</p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DialogBody key={`body-${dialog.id}`} dialog={dialog} onAnswer={answer} onCancel={cancel} />
      </div>
    </div>
  );
}

function DialogCountdown({ dialog }: { dialog: ExtensionDialogRequest }) {
  const deadline = useMemo(() => dialog.at + (dialog.timeout ?? 0), [dialog.at, dialog.timeout]);
  const [remaining, setRemaining] = useState(() => Math.max(0, deadline - Date.now()));

  useEffect(() => {
    const tick = (): void => {
      setRemaining(Math.max(0, deadline - Date.now()));
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [deadline]);

  return (
    <Badge tone={remaining <= 5000 ? "warn" : "neutral"}>
      auto-dismiss in {Math.ceil(remaining / 1000)}s
    </Badge>
  );
}

function DialogBody({
  dialog,
  onAnswer,
  onCancel,
}: {
  dialog: ExtensionDialogRequest;
  onAnswer: (
    dialog: ExtensionDialogRequest,
    answer: { value?: string; confirmed?: boolean },
  ) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(dialog.method === "editor" ? (dialog.prefill ?? "") : "");

  if (dialog.method === "select") {
    return <SelectOptions dialog={dialog} onAnswer={onAnswer} onCancel={onCancel} />;
  }

  if (dialog.method === "confirm") {
    return (
      <form
        className="flex justify-end gap-2 px-4 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          onAnswer(dialog, { confirmed: true });
        }}
      >
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" autoFocus data-autofocus="">
          Confirm
        </Button>
      </form>
    );
  }

  const multiline = dialog.method === "editor";
  return (
    <form
      className="flex flex-col gap-2 px-4 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer(dialog, { value: text });
      }}
    >
      {multiline ? (
        <textarea
          aria-label={dialog.title || "Extension input"}
          autoFocus
          data-autofocus=""
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            // Pi's ExtensionEditorComponent submits on Enter and inserts a
            // newline on Shift+Enter, like the main editor.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onAnswer(dialog, { value: text });
            }
          }}
          rows={10}
          className="w-full resize-y rounded-sm border border-line bg-raised px-2 py-1 font-mono text-xs text-ink outline-none"
        />
      ) : (
        <input
          aria-label={dialog.title || "Extension input"}
          autoFocus
          data-autofocus=""
          value={text}
          placeholder={dialog.placeholder ?? ""}
          onChange={(event) => setText(event.target.value)}
          className="w-full rounded-sm border border-line bg-raised px-2 py-1 text-sm text-ink outline-none"
        />
      )}
      {multiline ? (
        <div className="text-[11px] text-ink-faint">
          Enter submits · Shift+Enter newline · Esc cancels
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          Submit
        </Button>
      </div>
    </form>
  );
}

/**
 * The select list marks the selected row with a `→ ` prefix in the accent
 * colour and moves the selection with the arrow keys, so the answer is always
 * visible before it is given. A click still answers immediately.
 */
function SelectOptions({
  dialog,
  onAnswer,
  onCancel,
}: {
  dialog: ExtensionDialogRequest;
  onAnswer: (
    dialog: ExtensionDialogRequest,
    answer: { value?: string; confirmed?: boolean },
  ) => void;
  onCancel: () => void;
}) {
  const options = dialog.options;
  const [selected, setSelected] = useState(0);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);

  /** Moves the selection and the focus together, so Enter answers it. */
  const move = (delta: number): void => {
    if (options.length === 0) return;
    const next = (selected + delta + options.length) % options.length;
    setSelected(next);
    rows.current[next]?.focus();
  };

  if (options.length === 0) {
    return (
      <div className="flex flex-col gap-1 px-4 pb-4">
        <p className="text-xs text-ink-muted">The extension offered no options.</p>
        <div className="mt-2 flex justify-end">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="listbox"
      aria-label={dialog.title || "Options"}
      className="flex flex-col gap-1 px-4 pb-4"
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((option, index) => {
        const isSelected = index === selected;
        return (
          <Button
            key={`${option}-${index}`}
            variant="secondary"
            role="option"
            aria-selected={isSelected}
            autoFocus={index === 0}
            data-autofocus={index === 0 ? "" : undefined}
            ref={(node: HTMLButtonElement | null) => {
              rows.current[index] = node;
            }}
            className={cn(
              "h-auto w-full justify-start gap-2 whitespace-normal py-1.5 text-left",
              isSelected && "border-accent bg-selected underline decoration-2 decoration-accent",
            )}
            onFocus={() => setSelected(index)}
            onClick={() => onAnswer(dialog, { value: option })}
          >
            <span
              aria-hidden
              className={cn(
                "w-3 shrink-0 text-center font-mono",
                isSelected ? "text-accent" : "text-transparent",
              )}
            >
              {isSelected ? "→" : " "}
            </span>
            <span className="min-w-0 flex-1">{option}</span>
          </Button>
        );
      })}
      <div className="mt-2 flex justify-end">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
