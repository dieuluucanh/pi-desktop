import { useAppStore } from "../state/app-store";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";

/**
 * `/import` confirmation (2026-10-26 session-parity plan step 14).
 *
 * Importing replaces the conversation open in this tab, which is destructive and
 * invisible to undo, so the path is named before anything is read. Terminal Pi
 * asks the same question through its select prompt.
 */
export function ImportSessionDialog() {
  const prompt = useAppStore((state) => state.importPrompt);
  const cancel = useAppStore((state) => state.cancelImport);
  const confirm = useAppStore((state) => state.confirmImport);

  return (
    <Dialog open={prompt !== null} onOpenChange={(next) => (next ? undefined : cancel())}>
      <DialogContent aria-describedby={undefined} data-testid="import-session">
        <DialogTitle>Import this session?</DialogTitle>
        <DialogDescription>
          The conversation open in this tab will be replaced by the file below. The current session
          file stays on disk.
        </DialogDescription>
        <div className="px-4 pb-2">
          <code className="block break-all rounded-sm border border-line bg-sunken px-2 py-1 text-xs">
            {prompt?.path ?? ""}
          </code>
        </div>
        <div className="flex justify-end gap-2 px-4 pb-4">
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => void confirm()}>
            Import
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
