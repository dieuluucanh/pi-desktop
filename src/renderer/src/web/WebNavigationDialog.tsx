import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { useAppStore } from "../state/app-store";

/**
 * The "this link leaves the review" prompt (plan step 21).
 *
 * Main refuses an unrelated navigation and asks; this dialog is the answer. It is
 * mounted globally in `App.tsx` so the decision can be taken from any tab, and it
 * is a real dialog, which also hides the native view behind it.
 */
export function WebNavigationDialog() {
  const prompt = useAppStore((store) => store.webNavigationPrompt);
  const answer = useAppStore((store) => store.answerWebNavigation);
  const dismiss = useAppStore((store) => store.dismissWebNavigation);

  if (!prompt) return null;

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : dismiss())}>
      <DialogContent aria-describedby={undefined} className="w-[min(480px,92vw)]">
        <DialogTitle>Open this link?</DialogTitle>
        <DialogDescription>
          <span className="break-all font-mono text-[11px] text-ink-muted">{prompt.url}</span>
          <br />
          This link leaves the review page, so it was not opened automatically.
        </DialogDescription>
        <div className="flex flex-wrap justify-end gap-2 px-4 pb-4">
          <Button variant="ghost" onClick={dismiss}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => void answer("current-tab")}>
            Open in this tab
          </Button>
          <Button variant="secondary" onClick={() => void answer("new-tab")}>
            Open in a new tab
          </Button>
          <Button variant="primary" onClick={() => void answer("external")}>
            Open in browser
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
