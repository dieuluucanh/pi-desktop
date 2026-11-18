import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Kbd } from "../ui/kbd";
import { MultilineText } from "../ui/multiline-text";
import { useAppStore } from "../state/app-store";
import type { ExtensionDialogRequest } from "../../../shared/extension-ui";
import {
  dialogKeyAllowed,
  dialogKeyIntent,
  moveSelection,
  selectKeysFrom,
  type SelectKeys,
} from "./dialog-keys";

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
  /**
   * True when this dock's pane is the focused session pane. A background pane's
   * prompt must not steal keys (or focus) from the pane the user is using.
   */
  active?: boolean;
}

export function ExtensionDialogDock({
  dialog,
  maxHeight,
  focusToken = 0,
  active = true,
}: ExtensionDialogDockProps) {
  const answer = useAppStore((state) => state.answerExtensionDialog);
  const effectiveKeys = useAppStore((state) => state.keybindings?.effective ?? null);
  const keybindingsLoaded = useAppStore((state) => state.keybindingsLoaded);
  const loadKeybindings = useAppStore((state) => state.loadKeybindings);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const titleId = `extension-dialog-title-${dialog.id}`;
  // One answer/cancel per request: Enter + a click, two global listeners or a
  // key rollover must never send two `oi.respond` frames for the same id.
  const settledRef = useRef<string | null>(null);
  // `tui.select.*` from keybindings.json, with Pi's defaults until it lands.
  const keys = useMemo(() => selectKeysFrom(effectiveKeys), [effectiveKeys]);

  useEffect(() => {
    if (!active || keybindingsLoaded) return;
    // Same lazy profile-wide load `ShortcutsHelp` uses; failure leaves the
    // defaults in place and marks the snapshot loaded.
    void loadKeybindings();
  }, [active, keybindingsLoaded, loadKeybindings]);
  // A permission title can list several commands. Keep that list on its own
  // lines but never let it squeeze the answers out of the dock: the header
  // scrolls, the body keeps the remaining height.
  const titleMaxHeight = Math.max(1, Math.min(240, Math.floor(maxHeight * 0.45)));

  const answerOnce = useCallback(
    (request: ExtensionDialogRequest, value: { value?: string; confirmed?: boolean }): void => {
      if (settledRef.current === request.id) return;
      settledRef.current = request.id;
      void answer(request, value);
    },
    [answer],
  );

  const cancelOnce = useCallback((): void => {
    if (settledRef.current === dialog.id) return;
    settledRef.current = dialog.id;
    void answer(dialog, { cancelled: true });
  }, [answer, dialog]);

  useEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (!root) return;
    if (root.contains(document.activeElement)) return;
    const target = root.querySelector<HTMLElement>("[data-autofocus]");
    (target ?? root).focus();
  }, [active, dialog.id, focusToken]);

  // Focus-independent Escape/Ctrl+C. The root handler covers a focused dialog;
  // this listener covers the reported case where focus stayed on the page.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      const state = useAppStore.getState();
      if (!dialogKeyAllowed(event, rootRef.current, state)) return;
      const intent = dialogKeyIntent(event, {
        method: dialog.method,
        keys,
        hasSelection: !(window.getSelection()?.isCollapsed ?? true),
      });
      if (intent !== "cancel") return;
      event.preventDefault();
      cancelOnce();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, cancelOnce, dialog.method, keys]);

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
        const intent = dialogKeyIntent(
          {
            key: event.key,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
            isComposing: event.nativeEvent.isComposing,
          },
          {
            method: dialog.method,
            keys,
            hasSelection: !(window.getSelection()?.isCollapsed ?? true),
          },
        );
        if (intent !== "cancel") return;
        event.preventDefault();
        cancelOnce();
      }}
    >
      <div className="flex shrink-0 items-start gap-2 px-4 pt-3">
        <div
          data-testid="extension-dialog-title"
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain"
          style={{ maxHeight: titleMaxHeight }}
        >
          <h2 id={titleId} className="min-w-0 text-sm font-semibold">
            {/* Terminal Pi renders the title through pi-tui Text: hard newlines
                survive and tabs become three spaces. The workflow read/write
                gate puts one `  • command` per line here. */}
            <MultilineText style={{ tabSize: 3 }}>{dialog.title || "Extension"}</MultilineText>
          </h2>
        </div>
        {dialog.timeout ? <DialogCountdown key={`countdown-${dialog.id}`} dialog={dialog} /> : null}
      </div>
      {dialog.method === "confirm" && dialog.message ? (
        <p className="px-4 pb-2 text-xs text-ink-muted">
          <MultilineText>{dialog.message}</MultilineText>
        </p>
      ) : null}
      <div data-testid="extension-dialog-body" className="min-h-0 flex-1 overflow-y-auto">
        <DialogBody
          key={`body-${dialog.id}`}
          dialog={dialog}
          active={active}
          keys={keys}
          onAnswer={answerOnce}
          onCancel={cancelOnce}
        />
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
  active,
  keys,
  onAnswer,
  onCancel,
}: {
  dialog: ExtensionDialogRequest;
  active: boolean;
  keys: SelectKeys;
  onAnswer: (
    dialog: ExtensionDialogRequest,
    answer: { value?: string; confirmed?: boolean },
  ) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(dialog.method === "editor" ? (dialog.prefill ?? "") : "");

  if (dialog.method === "select") {
    return (
      <SelectOptions
        dialog={dialog}
        active={active}
        keys={keys}
        onAnswer={onAnswer}
        onCancel={onCancel}
      />
    );
  }

  if (dialog.method === "confirm") {
    return (
      <ConfirmOptions
        dialog={dialog}
        active={active}
        keys={keys}
        onAnswer={onAnswer}
        onCancel={onCancel}
      />
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
          autoFocus={active}
          data-autofocus={active ? "" : undefined}
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
          autoFocus={active}
          data-autofocus={active ? "" : undefined}
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
 * Confirm keeps terminal Pi's two-choice shape (Yes/No become Confirm/Cancel)
 * and its Up/Down roving focus. Enter is the browser's native button
 * activation, so a lost-focus Enter never silently confirms.
 */
function ConfirmOptions({
  dialog,
  active,
  keys,
  onAnswer,
  onCancel,
}: {
  dialog: ExtensionDialogRequest;
  active: boolean;
  keys: SelectKeys;
  onAnswer: (
    dialog: ExtensionDialogRequest,
    answer: { value?: string; confirmed?: boolean },
  ) => void;
  onCancel: () => void;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const choiceRef = useRef(0);

  const focusChoice = useCallback((index: number): void => {
    choiceRef.current = index;
    (index === 0 ? confirmRef : cancelRef).current?.focus();
  }, []);

  const move = useCallback(
    (delta: -1 | 1): void => {
      focusChoice(moveSelection(choiceRef.current, delta, 2));
    },
    [focusChoice],
  );

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      const state = useAppStore.getState();
      const own = formRef.current?.closest("[data-extension-dialog]") ?? null;
      if (!dialogKeyAllowed(event, own, state)) return;
      const intent = dialogKeyIntent(event, { method: "confirm", keys });
      if (intent !== "up" && intent !== "down") return;
      event.preventDefault();
      move(intent === "up" ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, keys, move]);

  return (
    <form
      ref={formRef}
      className="flex justify-end gap-2 px-4 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer(dialog, { confirmed: true });
      }}
    >
      <Button
        ref={cancelRef}
        type="button"
        variant="ghost"
        onFocus={() => {
          choiceRef.current = 1;
        }}
        onClick={onCancel}
      >
        Cancel
      </Button>
      <Button
        ref={confirmRef}
        type="submit"
        variant="primary"
        autoFocus={active}
        data-autofocus={active ? "" : undefined}
        onFocus={() => {
          choiceRef.current = 0;
        }}
      >
        Confirm
      </Button>
    </form>
  );
}

/**
 * The select list marks the selected row with a `→ ` prefix in the accent
 * colour and moves the selection with the arrow keys or j/k, clamping at the
 * ends like terminal Pi. While its pane is active it listens on the window, so
 * the reported case (focus left on the page) still navigates and answers.
 * A click still answers immediately.
 */
function SelectOptions({
  dialog,
  active,
  keys,
  onAnswer,
  onCancel,
}: {
  dialog: ExtensionDialogRequest;
  active: boolean;
  keys: SelectKeys;
  onAnswer: (
    dialog: ExtensionDialogRequest,
    answer: { value?: string; confirmed?: boolean },
  ) => void;
  onCancel: () => void;
}) {
  const options = dialog.options;
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selectRow = useCallback((index: number): void => {
    selectedRef.current = index;
    setSelected(index);
  }, []);

  /** Moves the selection and the focus together, so Enter answers it. */
  const move = useCallback(
    (delta: -1 | 1): void => {
      const next = moveSelection(selectedRef.current, delta, options.length);
      selectRow(next);
      rows.current[next]?.focus();
    },
    [options.length, selectRow],
  );

  const answerSelected = useCallback((): void => {
    const option = options[selectedRef.current];
    if (option === undefined) return;
    onAnswer(dialog, { value: option });
  }, [dialog, onAnswer, options]);

  // A re-activated pane brings its prompt back with the row the user left on.
  useEffect(() => {
    if (!active || options.length === 0) return;
    rows.current[selectedRef.current]?.focus();
  }, [active, options.length]);

  // Focus-independent navigation: the reported prompt lost DOM focus, so the
  // listbox's own onKeyDown never ran. This window listener covers both cases;
  // the native-control check keeps Enter from double-answering a focused button.
  useEffect(() => {
    if (!active || options.length === 0) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      const state = useAppStore.getState();
      const own = listRef.current?.closest("[data-extension-dialog]") ?? null;
      if (!dialogKeyAllowed(event, own, state)) return;
      const intent = dialogKeyIntent(event, { method: "select", keys });
      if (intent === "up" || intent === "down") {
        event.preventDefault();
        move(intent === "up" ? -1 : 1);
        return;
      }
      if (intent !== "confirm") return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("button, input, textarea, [contenteditable='true']")
      ) {
        // Enter on an option/Cancel is the browser's native click: answer once.
        return;
      }
      event.preventDefault();
      answerSelected();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, answerSelected, keys, move, options.length]);

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
    <div className="flex flex-col px-4 pb-4">
      <div
        ref={listRef}
        role="listbox"
        aria-label={dialog.title || "Options"}
        className="flex flex-col gap-1"
      >
        {options.map((option, index) => {
          const isSelected = index === selected;
          return (
            <Button
              key={`${option}-${index}`}
              variant="secondary"
              role="option"
              aria-selected={isSelected}
              autoFocus={active && index === 0}
              data-autofocus={active && index === 0 ? "" : undefined}
              ref={(node: HTMLButtonElement | null) => {
                rows.current[index] = node;
              }}
              className={cn(
                "h-auto w-full justify-start gap-2 whitespace-normal py-1.5 text-left",
                isSelected && "border-accent bg-selected underline decoration-2 decoration-accent",
              )}
              onFocus={() => selectRow(index)}
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
              <MultilineText className="min-w-0 flex-1">{option}</MultilineText>
            </Button>
          );
        })}
      </div>
      <SelectHint keys={keys} />
      <div className="mt-2 flex justify-end">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const KEY_LABELS: Record<string, string> = {
  up: "↑",
  down: "↓",
  enter: "Enter",
  escape: "Esc",
  "ctrl+c": "Ctrl+C",
};

function keyLabel(key: string): string {
  return KEY_LABELS[key] ?? key;
}

/** Pi's selector key-hint footer, rendered from the effective bindings. */
function SelectHint({ keys }: { keys: SelectKeys }) {
  return (
    <div
      data-testid="extension-dialog-select-hint"
      className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-ink-faint"
    >
      {keys.up.map((key) => (
        <Kbd key={`up-${key}`}>{keyLabel(key)}</Kbd>
      ))}
      <span>/</span>
      {keys.down.map((key) => (
        <Kbd key={`down-${key}`}>{keyLabel(key)}</Kbd>
      ))}
      <span>or</span>
      <Kbd>k</Kbd>
      <Kbd>j</Kbd>
      <span>navigate ·</span>
      {keys.confirm.map((key) => (
        <Kbd key={`confirm-${key}`}>{keyLabel(key)}</Kbd>
      ))}
      <span>select ·</span>
      {keys.cancel.map((key) => (
        <Kbd key={`cancel-${key}`}>{keyLabel(key)}</Kbd>
      ))}
      <span>cancel</span>
    </div>
  );
}
