/**
 * The Source Control panel's three git pieces (git-checkpoint plan step 13,
 * split for the docked rail's new order).
 *
 * The panel reads top to bottom the way VS Code's source-control view does:
 * **where am I** ({@link GitBranchBar}), then the commit composer, then **move**
 * ({@link GitSyncRow}), and below the fold the working tree, the stashes
 * ({@link StashList}) and the log. The split exists so the panel can pin the
 * branch line, the composer and the sync verbs while only the lists scroll —
 * one component could only have been one undifferentiated block.
 *
 * Fetch/pull/push never go through the write-consent dialog: they are explicit
 * buttons that name their target (`origin/main`), and the plan treats that as
 * their consent. Everything that rewrites the folder does go through it.
 */

import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GitBranch, RefreshCw } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { useAppStore } from "../state/app-store";
import {
  branchView,
  needsDirtyConfirmation,
  stashLabel,
  syncAvailability,
  syncTarget,
} from "./git-view";

const EMPTY_BRANCHES: readonly string[] = [];

export interface GitPartProps {
  projectPath: string;
}

/**
 * Where am I: the branch (or detached/empty), its upstream and divergence, the
 * switch/create menu — and the stashes, which are about the working tree rather
 * than the branch.
 *
 * This is the owner of the `git-section` test id: the whole Git surface has
 * carried it since the single-section rail, and callers still ask "is the Git
 * surface here at all?" with it.
 */
export function GitBranchBar({ projectPath }: GitPartProps) {
  const snapshot = useAppStore((state) => state.git[projectPath]);
  const branches = useAppStore((state) => state.gitBranches[projectPath] ?? EMPTY_BRANCHES);
  const loadGitBranches = useAppStore((state) => state.loadGitBranches);
  const performGitAction = useAppStore((state) => state.performGitAction);

  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newBranch, setNewBranch] = useState("");

  const repo = snapshot?.repo;
  const view = branchView(repo);
  if (!snapshot?.available || !view || !repo) return null;

  const dirty = needsDirtyConfirmation(snapshot);

  const switchTo = (branch: string): void => {
    if (branch === repo.branch) return;
    // A dirty tree means the switch can rewrite local edits; ask first.
    if (dirty) {
      setPendingBranch(branch);
      return;
    }
    void performGitAction(projectPath, { kind: "checkout-branch", branch });
  };

  const createBranch = (): void => {
    const branch = newBranch.trim();
    if (branch.length === 0) return;
    setCreating(false);
    setNewBranch("");
    void performGitAction(projectPath, { kind: "create-branch", branch });
  };

  return (
    <div className="flex flex-col gap-2 px-3 pb-2" data-testid="git-section">
      <div className="flex items-center gap-1.5">
        <GitBranch className="size-3 shrink-0 text-ink-faint" aria-hidden />
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs"
          title={view.label}
          data-testid="git-branch"
        >
          {view.label}
        </span>
        {view.ahead > 0 ? (
          <Badge tone="accent" title={`${view.ahead} commits to push`}>
            ↑{view.ahead}
          </Badge>
        ) : null}
        {view.behind > 0 ? (
          <Badge tone="warn" title={`${view.behind} commits to pull`}>
            ↓{view.behind}
          </Badge>
        ) : null}
      </div>

      <div className="flex items-center gap-2 text-[11px] text-ink-faint">
        <span className="min-w-0 flex-1 truncate" data-testid="git-upstream">
          {view.upstream ?? "no upstream"}
        </span>
        <button
          type="button"
          className="flex items-center gap-0.5 underline hover:text-ink"
          aria-label="Switch branch"
          aria-expanded={branchesOpen}
          onClick={() => {
            const next = !branchesOpen;
            setBranchesOpen(next);
            if (next) void loadGitBranches(projectPath);
          }}
        >
          {branchesOpen ? (
            <ChevronDown className="size-3" aria-hidden />
          ) : (
            <ChevronRight className="size-3" aria-hidden />
          )}
          Switch
        </button>
      </div>

      {/*
        An inline list rather than a floating menu: the panel is 320 px wide, and
        a portal-anchored popup in that column clips and steals pointer events.
      */}
      {branchesOpen ? (
        <div className="flex flex-col gap-0.5 rounded-sm border border-line bg-raised/40 p-1">
          {branches.length === 0 ? (
            <p className="px-1 text-[11px] text-ink-faint">No local branches.</p>
          ) : (
            branches.map((branch) => (
              <button
                key={branch}
                type="button"
                disabled={branch === repo.branch}
                aria-label={`Switch to ${branch}`}
                className="truncate rounded-xs px-1 text-left font-mono text-[11px] hover:bg-raised disabled:opacity-50"
                onClick={() => switchTo(branch)}
              >
                {branch}
                {branch === repo.branch ? " (current)" : ""}
              </button>
            ))
          )}
          <button
            type="button"
            className="rounded-xs px-1 text-left text-[11px] hover:bg-raised"
            onClick={() => setCreating(true)}
          >
            Create branch…
          </button>
        </div>
      ) : null}

      {creating ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            createBranch();
          }}
        >
          <input
            aria-label="New branch name"
            placeholder="feature/name"
            value={newBranch}
            onChange={(event) => setNewBranch(event.target.value)}
            className="min-w-0 flex-1 rounded-sm border border-line bg-sunken px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-accent"
          />
          <Button
            size="sm"
            variant="secondary"
            type="submit"
            disabled={newBranch.trim().length === 0}
          >
            Create
          </Button>
        </form>
      ) : null}

      {pendingBranch ? (
        <ConfirmDialog
          open
          title={`Switch to ${pendingBranch} with uncommitted changes?`}
          description="Git may refuse, or carry your edits across. Commit or stash them first to be sure nothing is lost."
          confirmLabel="Switch anyway"
          onConfirm={() => {
            const branch = pendingBranch;
            setPendingBranch(null);
            void performGitAction(projectPath, { kind: "checkout-branch", branch });
          }}
          onCancel={() => setPendingBranch(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Move: fetch, pull and push, each naming its target.
 *
 * Three buttons rather than one menu because a network operation should be an
 * explicit, readable act — and because the reason a verb is disabled ("no
 * upstream", "no remote") has to be visible next to it.
 */
export function GitSyncRow({ projectPath }: GitPartProps) {
  const snapshot = useAppStore((state) => state.git[projectPath]);
  const performGitAction = useAppStore((state) => state.performGitAction);

  const repo = snapshot?.repo;
  if (!snapshot?.available || !repo) return null;

  const target = syncTarget(repo);
  const sync = syncAvailability(repo);

  return (
    <div className="flex flex-col gap-1 px-3 pb-2" data-testid="git-sync">
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="secondary"
          className="flex-1"
          aria-label={target ? `Fetch from ${target.split("/")[0]}` : "Fetch"}
          title={target ? `Fetch from ${target.split("/")[0]}` : "Fetch"}
          disabled={!sync.fetch}
          onClick={() => void performGitAction(projectPath, { kind: "fetch", remote: null })}
        >
          <ArrowDown className="mr-1 size-3" aria-hidden />
          Fetch
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="flex-1"
          aria-label={target ? `Pull from ${target}` : "Pull"}
          title={sync.reason ?? (target ? `Pull from ${target}` : "Pull")}
          disabled={!sync.pull}
          onClick={() => void performGitAction(projectPath, { kind: "pull" })}
        >
          <RefreshCw className="mr-1 size-3" aria-hidden />
          Pull
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="flex-1"
          aria-label={target ? `Push to ${target}` : "Push"}
          title={sync.reason ?? (target ? `Push to ${target}` : "Push")}
          disabled={!sync.push}
          onClick={() => void performGitAction(projectPath, { kind: "push" })}
        >
          <ArrowUp className="mr-1 size-3" aria-hidden />
          Push
        </Button>
      </div>

      {sync.reason ? (
        <p className="text-[11px] text-ink-faint" data-testid="git-sync-note">
          {sync.reason}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The stash list: what is parked, and the two things you can do with it.
 *
 * `Stash changes` lives here rather than next to the commit box because it is a
 * working-tree action, and because the list is where a user returns to restore
 * or drop one.
 */
export function StashList({ projectPath }: GitPartProps) {
  const snapshot = useAppStore((state) => state.git[projectPath]);
  const performGitAction = useAppStore((state) => state.performGitAction);

  if (!snapshot?.available) return null;

  return (
    <div className="flex flex-col gap-1 px-3 pb-2" data-testid="git-stashes-section">
      <div className="flex items-center gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
          Stashes
        </h4>
        <Badge tone="neutral">{snapshot.stashes.length}</Badge>
        <button
          type="button"
          className="ml-auto text-[11px] text-ink-faint hover:text-ink"
          aria-label="Stash changes"
          onClick={() => void performGitAction(projectPath, { kind: "stash-push", message: null })}
        >
          Stash changes
        </button>
      </div>

      {snapshot.stashes.length === 0 ? (
        <p className="text-[11px] text-ink-faint" data-testid="git-stashes-empty">
          No stashes.
        </p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="git-stashes">
          {snapshot.stashes.map((stash) => (
            <li
              key={stash.ref}
              className="flex items-center gap-1 text-[11px]"
              data-testid={`stash-${stash.index}`}
            >
              <span className="min-w-0 flex-1 truncate" title={stash.subject}>
                {stashLabel(stash)}
              </span>
              <button
                type="button"
                className="text-ink-faint hover:text-ink"
                aria-label={`Restore ${stash.ref}`}
                onClick={() =>
                  void performGitAction(projectPath, { kind: "stash-pop", index: stash.index })
                }
              >
                Restore
              </button>
              <button
                type="button"
                className="text-ink-faint hover:text-danger"
                aria-label={`Drop ${stash.ref}`}
                onClick={() =>
                  void performGitAction(projectPath, { kind: "stash-drop", index: stash.index })
                }
              >
                Drop
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
