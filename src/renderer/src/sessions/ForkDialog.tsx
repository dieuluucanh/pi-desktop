import { GitFork } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { useAppStore } from "../state/app-store";

/**
 * Fork from a message (plan step 11).
 *
 * Pi can fork a session at any earlier user message, copying the branch into a
 * brand-new session file (`get_fork_messages` + `fork`). This dialog is the
 * desktop entry point; the tab menu and `/fork` open it.
 */

export function ForkDialog() {
  const open = useAppStore((state) => state.forkOpen);
  const close = useAppStore((state) => state.closeFork);
  const tabId = useAppStore((state) => state.activeTabId);
  const candidates = useAppStore((state) => state.forkCandidates);
  const forkFrom = useAppStore((state) => state.forkFrom);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent
        className="flex max-h-[70vh] flex-col"
        aria-describedby={undefined}
        data-testid="fork-dialog"
      >
        <DialogTitle>Fork from a message</DialogTitle>
        <DialogDescription>
          Starts a new session containing the conversation up to the message you pick.
        </DialogDescription>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {candidates.length === 0 ? (
            <p className="py-6 text-center text-xs text-ink-muted">
              There is no earlier message to fork from yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {candidates.map((candidate, index) => (
                <li key={candidate.entryId}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-2 rounded-sm border border-line bg-raised/40 px-2 py-1.5 text-left hover:border-line-strong"
                    onClick={() => tabId && void forkFrom(tabId, candidate.entryId)}
                  >
                    <GitFork className="mt-0.5 size-3.5 shrink-0 text-ink-faint" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[10px] text-ink-faint">
                        message {index + 1} of {candidates.length}
                      </span>
                      <span className="block truncate text-xs text-ink">{candidate.text}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end px-4 pb-4">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
