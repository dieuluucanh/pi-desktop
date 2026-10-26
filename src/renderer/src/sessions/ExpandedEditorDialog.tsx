import { useState } from "react";
import { useAppStore } from "../state/app-store";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";

/**
 * The expanded editor (2026-10-26 session-parity plan step 21).
 *
 * A cramped composer is the wrong place to write a long prompt. `Ctrl+G` (Pi's
 * `app.editor.external`) opens this dialog with the **expanded** draft — paste
 * markers resolved — and writes the result back into the composer on save.
 *
 * A configured OS editor is offered from here as a best effort; when none is
 * configured the dialog says so and stays open, which is why this exists as the
 * guaranteed path (terminal editors need a TTY the app does not have).
 *
 * The body is a separate component so opening the dialog *mounts* it: the text
 * is seeded from the draft in a `useState` initializer instead of an effect,
 * which keeps React from rendering twice on every open.
 */
export function ExpandedEditorDialog() {
  const open = useAppStore((state) => state.expandedEditorOpen);
  const close = useAppStore((state) => state.closeExpandedEditor);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent
        className="flex max-h-[86vh] flex-col"
        aria-describedby={undefined}
        data-testid="expanded-editor"
      >
        <DialogTitle>Edit prompt</DialogTitle>
        <DialogDescription>
          Save (Ctrl+Enter) writes this back into the composer. Esc cancels and keeps the draft.
        </DialogDescription>
        {open ? <ExpandedEditorBody /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ExpandedEditorBody() {
  const error = useAppStore((state) => state.expandedEditorError);
  const busy = useAppStore((state) => state.expandedEditorBusy);
  const close = useAppStore((state) => state.closeExpandedEditor);
  const save = useAppStore((state) => state.saveExpandedEditor);
  const openExternal = useAppStore((state) => state.openExternalEditor);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const [text, setText] = useState(() => {
    if (!activeTabId) return "";
    const state = useAppStore.getState();
    const draft = state.prefs.drafts[activeTabId] ?? "";
    return state.expandPastes(activeTabId, draft);
  });

  const lines = text.length === 0 ? 0 : text.split("\n").length;

  return (
    <>
      <div className="min-h-0 flex-1 px-4 pb-2">
        <textarea
          autoFocus
          aria-label="Expanded prompt"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              if (activeTabId) save(activeTabId, text);
            } else if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
          className="h-[52vh] w-full resize-none rounded-sm border border-line bg-surface px-3 py-2 font-mono text-xs text-ink outline-none focus:border-accent"
        />
        <div className="mt-1 flex items-center gap-3 text-[11px] text-ink-faint">
          <span data-testid="expanded-editor-count">
            {text.length} chars · {lines} lines
          </span>
          {error ? (
            <span className="text-warn" role="status">
              {error}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex justify-end gap-2 px-4 pb-4">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => activeTabId && void openExternal(activeTabId)}
          title="Open the configured OS editor (this dialog is the guaranteed fallback)"
        >
          Open OS editor
        </Button>
        <Button size="sm" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={() => activeTabId && save(activeTabId, text)}>
          Save
        </Button>
      </div>
    </>
  );
}
