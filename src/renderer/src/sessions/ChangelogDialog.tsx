import { useAppStore } from "../state/app-store";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { CHANGELOG_UNAVAILABLE } from "../../../shared/changelog";

/**
 * `/changelog` (2026-10-26 session-parity plan step 15).
 *
 * Terminal Pi prints Pi's packaged `CHANGELOG.md`. The host reads that exact
 * file through its file port, so the desktop shows the same release notes as the
 * CLI on this machine; a build without the file says so instead of pretending
 * there is nothing new.
 */
export function ChangelogDialog() {
  const open = useAppStore((state) => state.changelogOpen);
  const text = useAppStore((state) => state.changelogText);
  const path = useAppStore((state) => state.changelogPath);
  const error = useAppStore((state) => state.changelogError);
  const close = useAppStore((state) => state.closeChangelog);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent
        className="flex max-h-[74vh] flex-col"
        aria-describedby={undefined}
        data-testid="changelog"
      >
        <DialogTitle>Pi changelog</DialogTitle>
        <DialogDescription>
          Release notes shipped with the Pi coding agent this app runs.
        </DialogDescription>
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          {error ? (
            <p className="text-xs text-danger" role="alert">
              {error}
            </p>
          ) : text ? (
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-ink-muted">
              {text}
            </pre>
          ) : (
            <p className="text-xs text-ink-faint">
              {path ? CHANGELOG_UNAVAILABLE : "Loading the changelog…"}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
