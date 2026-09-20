import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
    return (
      <div className="flex flex-col gap-1 px-4 pb-4">
        {dialog.options.length === 0 ? (
          <p className="text-xs text-ink-muted">The extension offered no options.</p>
        ) : null}
        {dialog.options.map((option, index) => (
          <Button
            key={`${option}-${index}`}
            variant="secondary"
            autoFocus={index === 0}
            className="justify-start"
            onClick={() => onAnswer(dialog, { value: option })}
          >
            {option}
          </Button>
        ))}
        <div className="mt-2 flex justify-end">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
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
