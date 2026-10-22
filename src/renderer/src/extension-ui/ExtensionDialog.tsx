import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { useAppStore } from "../state/app-store";
import type { ExtensionDialogRequest } from "../../../shared/extension-ui";

/**
 * Extension dialogs (plan step 16).
 *
 * One extension call (`ctx.ui.select/confirm/input/editor`) blocks until the app
 * answers, so this renders the oldest queued dialog for the active tab and
 * answers it through `oi.respond`. Keyboard-first: Escape cancels, Enter submits,
 * the first option is focused, and an extension-provided `timeout` shows a live
 * countdown that cancels when it reaches zero.
 */
export function ExtensionDialog() {
  const dialog = useAppStore((state) => state.extensionDialogs[0] ?? null);
  const answer = useAppStore((state) => state.answerExtensionDialog);

  const cancel = (request: ExtensionDialogRequest): void => {
    void answer(request, { cancelled: true });
  };

  return (
    <Dialog
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open && dialog) cancel(dialog);
      }}
    >
      {dialog ? (
        <DialogContent aria-label={`Extension dialog: ${dialog.title}`}>
          <DialogTitle>{dialog.title || "Extension"}</DialogTitle>
          {dialog.method === "confirm" && dialog.message ? (
            <DialogDescription>{dialog.message}</DialogDescription>
          ) : null}
          {dialog.timeout ? (
            <DialogCountdown
              key={`countdown-${dialog.id}`}
              dialog={dialog}
              onExpire={() => cancel(dialog)}
            />
          ) : null}
          <DialogBody
            key={`body-${dialog.id}`}
            dialog={dialog}
            onAnswer={answer}
            onCancel={() => cancel(dialog)}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function DialogCountdown({
  dialog,
  onExpire,
}: {
  dialog: ExtensionDialogRequest;
  onExpire: () => void;
}) {
  const deadline = useMemo(() => dialog.at + (dialog.timeout ?? 0), [dialog.at, dialog.timeout]);
  const [remaining, setRemaining] = useState(() => Math.max(0, deadline - Date.now()));
  const expired = useRef(false);

  useEffect(() => {
    expired.current = false;
    const timer = setInterval(() => {
      const next = Math.max(0, deadline - Date.now());
      setRemaining(next);
      if (next === 0 && !expired.current) {
        expired.current = true;
        clearInterval(timer);
        onExpire();
      }
    }, 250);
    return () => clearInterval(timer);
  }, [deadline, onExpire]);

  return (
    <div className="px-4 pb-2">
      <Badge tone={remaining <= 5000 ? "warn" : "neutral"}>
        auto-dismiss in {Math.ceil(remaining / 1000)}s
      </Badge>
    </div>
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
        <Button type="submit" variant="primary" autoFocus>
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
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={10}
          className="w-full resize-y rounded-sm border border-line bg-raised px-2 py-1 font-mono text-xs text-ink outline-none"
        />
      ) : (
        <input
          aria-label={dialog.title || "Extension input"}
          autoFocus
          value={text}
          placeholder={dialog.placeholder ?? ""}
          onChange={(event) => setText(event.target.value)}
          className="w-full rounded-sm border border-line bg-raised px-2 py-1 text-sm text-ink outline-none"
        />
      )}
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
 * The select dialog (plan step 4).
 *
 * Pi's own select list marks the selected row with a `→ ` prefix in the accent
 * colour and moves the selection with the arrow keys, so the answer is always
 * visible before it is given. The app follows that model: the list is a
 * listbox, the selected row is marked, `↑`/`↓` move the selection (wrapping),
 * `Enter` answers with the selected option and `Esc` cancels (the dialog
 * handles that). A click still answers immediately.
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
