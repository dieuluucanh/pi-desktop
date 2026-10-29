/**
 * The one-time git write consent (git-checkpoint plan steps 12-13, D13).
 *
 * Mutating git commands run in the user's folder, so the first one in a session
 * asks — and then never again until the app restarts. The dialog names the
 * concrete action rather than a generic "allow writes", because consent to
 * staging a file is not obviously consent to switching branches.
 *
 * Fetch, pull and push never pass through here: they are their own explicit
 * buttons, named with the remote they act on.
 */

import { ShieldAlert } from "lucide-react";
import { useAppStore } from "../state/app-store";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { consentScopeNote, mutatingActionLabel } from "./git-view";

export function GitConsentDialog() {
  const prompt = useAppStore((state) => state.gitConsentPrompt);
  const confirm = useAppStore((state) => state.confirmGitConsent);
  const cancel = useAppStore((state) => state.cancelGitConsent);

  if (!prompt) return null;

  return (
    <ConfirmDialog
      open
      tone="accent"
      title="Allow git writes in this session?"
      description={
        <>
          Pi Desktop wants to{" "}
          <strong className="text-ink">{mutatingActionLabel(prompt.action.kind)}</strong> in{" "}
          <span className="font-mono text-ink">{prompt.projectPath}</span>. {consentScopeNote()}
        </>
      }
      confirmLabel="Allow and continue"
      cancelLabel="Not now"
      onConfirm={() => void confirm()}
      onCancel={cancel}
    >
      <div className="mx-4 mb-1 flex items-start gap-2 rounded-sm border border-line bg-raised px-3 py-2 text-[11px] text-ink-muted">
        <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
        <span>
          Nothing outside this repository is touched. Discarding an untracked file moves it to the
          system trash, and destructive actions take a checkpoint first when checkpoints are on.
        </span>
      </div>
    </ConfirmDialog>
  );
}
