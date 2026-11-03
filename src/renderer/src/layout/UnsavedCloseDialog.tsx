import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { useEditorStore } from "../editor/editor-store";

/**
 * The Save / Discard / Cancel prompt for a dirty editor tab.
 *
 * Closing the window does not go through this dialog; dirty buffers are backed
 * up to userData, so a crash or a normal quit restores the text. This prompt is
 * for the explicit "close this tab" gesture, where the user is about to discard
 * the buffer's only home.
 */
export function UnsavedCloseDialog(): React.JSX.Element | null {
  const pending = useEditorStore((state) => state.pendingClose);
  const meta = useEditorStore((state) =>
    state.pendingClose ? state.meta[state.pendingClose.tabId] : undefined,
  );
  const answer = useEditorStore((state) => state.answerClose);
  if (pending === null) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void answer("cancel");
      }}
    >
      <DialogContent aria-describedby={undefined} data-testid="unsaved-close-dialog">
        <DialogTitle className="px-4 pt-4">Unsaved changes</DialogTitle>
        <DialogDescription className="px-4 pb-3">
          {meta?.path ?? "This file"} has changes that have not been saved.
          {pending.remaining > 1 ? ` (1 of ${pending.remaining} files)` : ""}
        </DialogDescription>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <Button size="sm" variant="ghost" onClick={() => void answer("cancel")}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" onClick={() => void answer("discard")}>
            Discard
          </Button>
          <Button size="sm" onClick={() => void answer("save")}>
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
