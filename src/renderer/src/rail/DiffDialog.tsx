/**
 * The diff viewer (git-checkpoint plan step 14).
 *
 * A full-width dialog over the session: per-file sections with add/remove
 * counts, unified hunks with line numbers on both sides, and a *Stage hunk* /
 * *Unstage hunk* button per hunk. Commit diffs are read-only, and a binary file
 * is a one-line row rather than an empty viewer that looks like a bug.
 *
 * The hunk action rebuilds a one-hunk patch from the parsed file
 * (`shared/git-patch`), so `git apply --cached` sees exactly what git printed.
 */

import { X } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { useAppStore } from "../state/app-store";
import { buildHunkPatch } from "../../../shared/git-patch";
import { gitStatusLetter, gitStatusTone, type GitDiffFile } from "../../../shared/git";

const SCOPE_LABEL = {
  working: "Changes",
  staged: "Staged changes",
  commit: "Commit",
} as const;

function HunkLines({ file, hunkIndex }: { file: GitDiffFile; hunkIndex: number }) {
  const hunk = file.hunks[hunkIndex];
  if (!hunk) return null;
  return (
    <div className="font-mono text-[11px] leading-5">
      {hunk.lines.map((line, index) => (
        <div
          key={`${hunkIndex}:${index}`}
          className={
            line.kind === "add"
              ? "flex bg-ok/10"
              : line.kind === "remove"
                ? "flex bg-danger/10"
                : "flex"
          }
        >
          <span className="w-10 shrink-0 select-none px-1 text-right text-ink-faint">
            {line.oldLine ?? ""}
          </span>
          <span className="w-10 shrink-0 select-none px-1 text-right text-ink-faint">
            {line.newLine ?? ""}
          </span>
          <span className="w-4 shrink-0 select-none text-center text-ink-faint">
            {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

function Hunk({ file, hunkIndex }: { file: GitDiffFile; hunkIndex: number }) {
  const state = useAppStore((s) => s.gitDiff);
  const performGitAction = useAppStore((s) => s.performGitAction);
  const openGitDiff = useAppStore((s) => s.openGitDiff);

  const hunk = file.hunks[hunkIndex];
  if (!hunk || !state) return null;
  const staged = state.diff.scope === "staged";
  const readOnly = state.diff.scope === "commit";

  const apply = async (): Promise<void> => {
    const result = await performGitAction(state.projectPath, {
      kind: staged ? "unstage-hunk" : "stage-hunk",
      path: file.path,
      patch: buildHunkPatch(file, hunk),
    });
    // Re-read the same side so the viewer reflects the new index instead of
    // showing a hunk that is no longer there.
    if (result?.ok) await openGitDiff(state.projectPath, state.request);
  };

  return (
    <div className="border-t border-line" data-testid={`hunk-${file.path}-${hunkIndex}`}>
      <div className="flex items-center gap-2 bg-raised/40 px-2 py-0.5">
        <span className="font-mono text-[11px] text-ink-faint">@@ {hunk.header} @@</span>
        {readOnly ? null : (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            aria-label={`${staged ? "Unstage" : "Stage"} hunk ${hunkIndex + 1} of ${file.path}`}
            onClick={() => void apply()}
          >
            {staged ? "Unstage hunk" : "Stage hunk"}
          </Button>
        )}
      </div>
      <HunkLines file={file} hunkIndex={hunkIndex} />
    </div>
  );
}

function FileSection({ file }: { file: GitDiffFile }) {
  return (
    <section className="flex flex-col" data-testid={`diff-file-${file.path}`}>
      <header className="sticky top-0 flex items-center gap-2 border-y border-line bg-surface px-3 py-1">
        <Badge tone={gitStatusTone(file.status)} className="font-mono">
          {gitStatusLetter(file.status)}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
          {file.origPath ? `${file.origPath} → ${file.path}` : file.path}
        </span>
        {file.binary ? (
          <Badge tone="neutral">binary</Badge>
        ) : (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-ok">+{file.added}</span>{" "}
            <span className="text-danger">−{file.removed}</span>
          </span>
        )}
      </header>
      {file.binary ? (
        <p className="px-3 py-2 text-[11px] text-ink-muted" data-testid={`binary-${file.path}`}>
          Binary file changed. The app cannot show a text diff for it.
        </p>
      ) : (
        file.hunks.map((_, index) => <Hunk key={index} file={file} hunkIndex={index} />)
      )}
    </section>
  );
}

export function DiffDialog() {
  const state = useAppStore((s) => s.gitDiff);
  const loading = useAppStore((s) => s.gitDiffLoading);
  const close = useAppStore((s) => s.closeGitDiff);

  if (!state && !loading) return null;

  const diff = state?.diff;
  const title = state?.request.path ?? (state?.request.commit ? "Commit" : "All changes");
  const files = diff?.files ?? [];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent aria-describedby={undefined} className="max-w-6xl" data-testid="diff-dialog">
        <div className="flex items-center gap-2 px-4 pt-4">
          <DialogTitle className="min-w-0 flex-1 truncate px-0 pt-0">{title}</DialogTitle>
          {diff ? <Badge tone="neutral">{SCOPE_LABEL[diff.scope]}</Badge> : null}
          <button
            type="button"
            className="text-ink-faint hover:text-ink"
            aria-label="Close diff"
            onClick={close}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <DialogDescription className="sr-only">
          A side-by-side view of the changed lines with per-hunk staging.
        </DialogDescription>

        <div className="max-h-[75vh] min-h-40 overflow-auto px-1 pb-2">
          {loading ? (
            <p className="px-3 py-6 text-xs text-ink-muted">Loading diff…</p>
          ) : diff?.tooLarge ? (
            <p className="px-3 py-6 text-xs text-warn" data-testid="diff-too-large">
              This diff is too large to show here. Use your editor or a terminal for this change.
            </p>
          ) : files.length === 0 ? (
            <p className="px-3 py-6 text-xs text-ink-muted" data-testid="diff-empty">
              No differences on this side.
            </p>
          ) : (
            files.map((file) => <FileSection key={file.path} file={file} />)
          )}
        </div>

        {diff?.truncated ? (
          <p className="px-4 pb-2 text-[11px] text-warn">
            Only the first files are shown; this change is larger than the viewer's limit.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
