/**
 * The Changes section (git-checkpoint plan step 11).
 *
 * The two lists VS Code's source-control view made familiar — **Staged
 * Changes** and **Changes** — with the letters a user already reads (`M`, `A`,
 * `D`, `R`, `C`, `U`, `!`), per-file actions, and the group actions that make a
 * multi-file change one click.
 *
 * Two deliberate differences from VS Code, both for honesty:
 *
 *  - **Discard only appears on an unstaged row.** The service's discard reverts
 *    the work tree to the index, which is exactly what that row shows; a staged
 *    row has no work-tree edit to revert, so the row says *Unstage* instead of
 *    offering an action whose meaning would be ambiguous.
 *  - **An untracked discard says "Move to trash".** It calls the OS trash, not
 *    `rm`, and the confirmation names the file (plan D11).
 */

import { useState } from "react";
import { FileText, Plus, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { useAppStore } from "../state/app-store";
import { gitStatusLetter, gitStatusTone, type GitFileEntry } from "../../../shared/git";
import { discardPrompt, emptyStateFor, groupsOf, isUntracked, renameLabel } from "./changes-view";

export interface ChangesSectionProps {
  /** The folder the rail is showing (a tab's cwd or a remembered project). */
  projectPath: string;
}

/** One status letter, using the app's own tones rather than a literal colour. */
function StatusBadge({ file }: { file: GitFileEntry }) {
  return (
    <Badge
      tone={gitStatusTone(file.status)}
      className="w-5 justify-center px-0 font-mono"
      title={file.status}
      data-testid={`status-${file.path}`}
    >
      {gitStatusLetter(file.status)}
    </Badge>
  );
}

function FileRow({
  file,
  staged,
  projectPath,
  onDiscard,
}: {
  file: GitFileEntry;
  /** Which list this row is in, so the diff and the actions mean the right side. */
  staged: boolean;
  projectPath: string;
  onDiscard: (file: GitFileEntry) => void;
}) {
  const performGitAction = useAppStore((state) => state.performGitAction);
  const openGitDiff = useAppStore((state) => state.openGitDiff);
  const untracked = isUntracked(file);
  const renamed = renameLabel(file);

  return (
    <li
      className="group flex items-center gap-1.5 px-3 py-0.5 text-xs hover:bg-raised/50"
      data-testid={`change-row-${file.path}`}
    >
      <StatusBadge file={file} />
      <span className="min-w-0 flex-1 truncate" title={file.path}>
        {renamed ? (
          <>
            <span className="text-ink-faint">{file.origPath} → </span>
            {file.path}
          </>
        ) : (
          file.path
        )}
      </span>

      {/* Hover-revealed, but always in the DOM so keyboard and tests reach them. */}
      <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {untracked ? null : (
          <button
            type="button"
            className="text-ink-faint hover:text-ink"
            aria-label={`Show diff for ${file.path}`}
            title="Show diff"
            onClick={() => void openGitDiff(projectPath, { path: file.path, staged })}
          >
            <FileText className="size-3" aria-hidden />
          </button>
        )}
        <button
          type="button"
          className="text-ink-faint hover:text-ink"
          aria-label={staged ? `Unstage ${file.path}` : `Stage ${file.path}`}
          title={staged ? "Unstage" : "Stage"}
          onClick={() =>
            void performGitAction(projectPath, {
              kind: staged ? "unstage" : "stage",
              paths: [file.path],
            })
          }
        >
          {staged ? (
            <RotateCcw className="size-3" aria-hidden />
          ) : (
            <Plus className="size-3" aria-hidden />
          )}
        </button>
        {staged ? null : (
          <button
            type="button"
            className="text-ink-faint hover:text-danger"
            aria-label={`Discard changes in ${file.path}`}
            title={untracked ? "Move to trash" : "Discard changes"}
            onClick={() => onDiscard(file)}
          >
            <Trash2 className="size-3" aria-hidden />
          </button>
        )}
      </span>
    </li>
  );
}

function Group({
  title,
  files,
  staged,
  projectPath,
  actionLabel,
  onAction,
  onDiscard,
}: {
  title: string;
  files: GitFileEntry[];
  staged: boolean;
  projectPath: string;
  actionLabel: string;
  onAction: () => void;
  onDiscard: (file: GitFileEntry) => void;
}) {
  if (files.length === 0) return null;
  return (
    <section
      className="flex flex-col"
      data-testid={`changes-group-${staged ? "staged" : "changed"}`}
    >
      <div className="flex items-center gap-2 px-3 py-1">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
          {title}
        </h4>
        <Badge tone="neutral">{files.length}</Badge>
        <button
          type="button"
          className="ml-auto text-[11px] text-ink-faint hover:text-ink"
          onClick={onAction}
        >
          {actionLabel}
        </button>
      </div>
      <ul className="flex flex-col">
        {files.map((file) => (
          <FileRow
            key={`${staged ? "s" : "c"}:${file.path}`}
            file={file}
            staged={staged}
            projectPath={projectPath}
            onDiscard={onDiscard}
          />
        ))}
      </ul>
    </section>
  );
}

export function ChangesSection({ projectPath }: ChangesSectionProps) {
  const snapshot = useAppStore((state) => state.git[projectPath]);
  const gitError = useAppStore((state) => state.gitError);
  const clearGitError = useAppStore((state) => state.clearGitError);
  const performGitAction = useAppStore((state) => state.performGitAction);
  const refreshGit = useAppStore((state) => state.refreshGit);
  const [discardTarget, setDiscardTarget] = useState<GitFileEntry | null>(null);

  const groups = groupsOf(snapshot);
  const empty = emptyStateFor(snapshot, snapshot?.reason);

  const stageAll = (): void => {
    void performGitAction(projectPath, {
      kind: "stage",
      paths: groups.changed.map((file) => file.path),
    });
  };

  const unstageAll = (): void => {
    void performGitAction(projectPath, {
      kind: "unstage",
      paths: groups.staged.map((file) => file.path),
    });
  };

  const confirmDiscard = (): void => {
    const file = discardTarget;
    setDiscardTarget(null);
    if (!file) return;
    void performGitAction(projectPath, {
      kind: "discard",
      paths: [file.path],
      untracked: isUntracked(file),
    });
  };

  return (
    <div className="flex flex-col gap-1 pb-2" data-testid="changes-section">
      {gitError ? (
        <div
          className="mx-2 flex items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] text-danger"
          role="alert"
          data-testid="git-error"
        >
          <span className="min-w-0 flex-1">{gitError}</span>
          <button
            type="button"
            className="shrink-0 text-danger/80 hover:text-danger"
            aria-label="Dismiss git error"
            onClick={clearGitError}
          >
            <X className="size-3" aria-hidden />
          </button>
        </div>
      ) : null}

      {empty ? (
        <div className="px-3 py-3 text-xs text-ink-muted" data-testid="changes-empty">
          <p className="font-medium text-ink">{empty.title}</p>
          <p className="mt-1">{empty.body}</p>
          {empty.action === "init" ? (
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => void performGitAction(projectPath, { kind: "init" })}
            >
              Initialize repository
            </Button>
          ) : null}
        </div>
      ) : null}

      {groups.truncated ? (
        <p className="px-3 py-1 text-[11px] text-warn" data-testid="changes-truncated">
          This repository has more changed paths than the panel shows. Use a terminal for the rest.
        </p>
      ) : null}

      <Group
        title="Staged Changes"
        files={groups.staged}
        staged
        projectPath={projectPath}
        actionLabel="Unstage all"
        onAction={unstageAll}
        onDiscard={setDiscardTarget}
      />
      <Group
        title="Changes"
        files={groups.changed}
        staged={false}
        projectPath={projectPath}
        actionLabel="Stage all"
        onAction={stageAll}
        onDiscard={setDiscardTarget}
      />

      <div className="flex items-center justify-end px-3 pt-1">
        <button
          type="button"
          className="flex items-center gap-1 text-[11px] text-ink-faint hover:text-ink"
          aria-label="Refresh changes"
          onClick={() => void refreshGit(projectPath)}
        >
          <RefreshCw className="size-3" aria-hidden /> Refresh
        </button>
      </div>

      {discardTarget ? (
        <ConfirmDialog
          open
          title={discardPrompt(discardTarget).title}
          description={discardPrompt(discardTarget).description}
          confirmLabel={discardPrompt(discardTarget).confirmLabel}
          onConfirm={confirmDiscard}
          onCancel={() => setDiscardTarget(null)}
        />
      ) : null}
    </div>
  );
}
