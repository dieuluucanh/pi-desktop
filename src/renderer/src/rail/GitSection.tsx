/**
 * The Source Control panel's git pieces, in their compact form.
 *
 * Everything here lives in the panel's **top block** (with the composer), so it
 * has to earn its rows: the previous layout stacked five of them before a single
 * changed file was visible in a ~500 px column. Hence:
 *
 *  - **{@link GitBranchRow}** is *one* row: branch icon, the branch name as the
 *    switch button, the divergence badges, then icon-only fetch/pull/push. The
 *    four facts a user actually reads stay on one line; the upstream text and the
 *    reason a verb is unavailable move into the button's `title`, and the reason
 *    also becomes a note line — but **only when it changes what you can do**.
 *  - **{@link StashList}** is collapsed by default (`prefs.rail.collapsed.stashes`)
 *    and costs one header row instead of four while unused. Its *Stash changes*
 *    action stays enabled while collapsed, because that is the action you reach
 *    for when you have edits you do not want to commit.
 *
 * Fetch/pull/push never go through the write-consent dialog: they are explicit
 * buttons that name their target (`origin/main`), and the plan treats that as
 * their consent. Everything that rewrites the folder does go through it.
 */

import { useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { syncProgressLabel } from "../../../shared/git";
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
export function GitBranchRow({ projectPath }: GitPartProps) {
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
    <div className="flex flex-col gap-1 px-3 pt-2 pb-1" data-testid="git-section">
      {/* One row: where am I, how far off, and how do I move it. */}
      <div className="flex items-center gap-1.5">
        <GitBranch className="size-3 shrink-0 text-ink-faint" aria-hidden />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-accent"
          aria-label="Switch branch"
          aria-expanded={branchesOpen}
          title={`${view.label}${view.upstream ? ` → ${view.upstream}` : ""}`}
          data-testid="git-branch"
          onClick={() => {
            const next = !branchesOpen;
            setBranchesOpen(next);
            if (next) void loadGitBranches(projectPath);
          }}
        >
          <span className="truncate font-mono text-xs" title={view.label}>
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
        </button>
        {/* The upstream text stays in the DOM (tests and screen readers read it),
            but it is only *shown* as the note line below when a verb is blocked. */}
        <span className="sr-only" data-testid="git-upstream">
          {view.upstream ?? "no upstream"}
        </span>
        <GitSyncButtons projectPath={projectPath} />
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
 * The three sync verbs, icon-only so they fit on the branch row.
 *
 * Their accessible name still carries the target (`Pull from origin/main`) and
 * their `title` carries either the target or the reason they are disabled, which
 * is where a user hovering a greyed button looks. The reason is also rendered
 * once, below, but only when it actually blocks something — a permanent
 * "origin/main" note would cost a row on every project to say nothing new.
 */
export function GitSyncButtons({ projectPath }: GitPartProps) {
  const snapshot = useAppStore((state) => state.git[projectPath]);
  const syncState = useAppStore((state) => state.gitSync[projectPath]);
  const performGitAction = useAppStore((state) => state.performGitAction);

  const repo = snapshot?.repo;
  if (!snapshot?.available || !repo) return null;

  const target = syncTarget(repo);
  const sync = syncAvailability(repo);
  const remote = target?.split("/")[0];
  const running = syncState?.phase === "running";
  const runningKind = running ? syncState.action.kind : null;

  return (
    <div className="flex shrink-0 items-center gap-0.5" data-testid="git-sync" aria-busy={running}>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={remote ? `Fetch from ${remote}` : "Fetch"}
        title={sync.fetch ? (remote ? `Fetch from ${remote}` : "Fetch") : (sync.reason ?? "Fetch")}
        disabled={!sync.fetch || running}
        onClick={() =>
          void performGitAction(projectPath, { kind: "fetch", remote: remote ?? null })
        }
      >
        {runningKind === "fetch" ? (
          <Loader2
            className="size-3 animate-spin"
            aria-hidden
            data-testid="git-sync-spinner-fetch"
          />
        ) : (
          <ArrowDown className="size-3" aria-hidden />
        )}
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={target ? `Pull from ${target}` : "Pull"}
        title={sync.pull ? (target ? `Pull from ${target}` : "Pull") : (sync.reason ?? "Pull")}
        disabled={!sync.pull || running}
        onClick={() => void performGitAction(projectPath, { kind: "pull" })}
      >
        {runningKind === "pull" ? (
          <Loader2
            className="size-3 animate-spin"
            aria-hidden
            data-testid="git-sync-spinner-pull"
          />
        ) : (
          <RefreshCw className="size-3" aria-hidden />
        )}
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={target ? `Push to ${target}` : "Push"}
        title={sync.push ? (target ? `Push to ${target}` : "Push") : (sync.reason ?? "Push")}
        disabled={!sync.push || running}
        onClick={() => void performGitAction(projectPath, { kind: "push" })}
      >
        {runningKind === "push" ? (
          <Loader2
            className="size-3 animate-spin"
            aria-hidden
            data-testid="git-sync-spinner-push"
          />
        ) : (
          <ArrowUp className="size-3" aria-hidden />
        )}
      </Button>
    </div>
  );
}

/**
 * The outcome of the last network action, directly under the buttons that
 * produced it. The Changes block's banner stays the panel-wide record; this line
 * is the answer at the click site, and it is keyed by folder like the status.
 */
export function GitSyncStatus({ projectPath }: GitPartProps) {
  const snapshot = useAppStore((state) => state.git[projectPath]);
  const status = useAppStore((state) => state.gitSync[projectPath]);
  const clearGitSync = useAppStore((state) => state.clearGitSync);
  const performGitAction = useAppStore((state) => state.performGitAction);

  if (!status) return null;

  const target = syncTarget(snapshot?.repo);
  const remote = target?.split("/")[0];
  const running = status.phase === "running";
  // Fetch names the remote it talks to; pull and push name the tracking ref.
  const where =
    status.action.kind === "fetch"
      ? remote
        ? ` from ${remote}`
        : ""
      : target
        ? ` ${status.action.kind === "push" ? "to" : "from"} ${target}`
        : "";
  const tone =
    status.phase === "error"
      ? "border-danger/40 bg-danger/10 text-danger"
      : "border-line bg-raised/40 text-ink-muted";

  return (
    <div
      className={`mx-3 mb-1 flex items-start gap-2 rounded-sm border px-2 py-1 text-[11px] ${tone}`}
      role={status.phase === "error" ? "alert" : "status"}
      data-testid="git-sync-status"
      data-phase={status.phase}
    >
      {running ? (
        <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin" aria-hidden />
      ) : status.phase === "ok" ? (
        <Check className="mt-0.5 size-3 shrink-0 text-accent" aria-hidden />
      ) : (
        <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        {running ? `${syncProgressLabel(status.action.kind)}${where}…` : status.message}
      </span>
      {status.phase === "error" ? (
        <button
          type="button"
          className="shrink-0 underline hover:text-ink"
          onClick={() => void performGitAction(projectPath, status.action)}
        >
          Retry
        </button>
      ) : null}
      {running ? null : (
        <button
          type="button"
          className="shrink-0 opacity-70 hover:opacity-100"
          aria-label="Dismiss sync status"
          onClick={() => clearGitSync(projectPath)}
        >
          <X className="size-3" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** The one-line explanation, rendered only when a verb is unavailable. */
export function GitSyncNote({ projectPath }: GitPartProps) {
  const snapshot = useAppStore((state) => state.git[projectPath]);
  const repo = snapshot?.repo;
  if (!snapshot?.available || !repo) return null;
  const sync = syncAvailability(repo);
  if (!sync.reason) return null;
  return (
    <p className="px-3 pb-1 text-[11px] text-ink-faint" data-testid="git-sync-note">
      {sync.reason}
    </p>
  );
}

/**
 * The stash list: what is parked, and the two things you can do with it.
 *
 * Collapsed by default (`prefs.rail.collapsed.stashes === true`): three stashes
 * cost four rows, and most sessions never use them. The header keeps the count
 * and the *Stash changes* action **outside** the fold, because stashing is what
 * you do while looking at a change you do not want to commit — reaching it must
 * not require expanding a list you do not care about.
 */
export function StashList({ projectPath }: GitPartProps) {
  const snapshot = useAppStore((state) => state.git[projectPath]);
  const performGitAction = useAppStore((state) => state.performGitAction);
  const collapsed = useAppStore((state) => state.prefs.rail.collapsed.stashes);
  const setSourceControlCollapsed = useAppStore((state) => state.setSourceControlCollapsed);

  if (!snapshot?.available) return null;

  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const listId = "git-stashes-body";

  return (
    <div className="flex flex-col gap-1 px-3 py-1" data-testid="git-stashes-section">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-2"
          aria-expanded={!collapsed}
          aria-controls={listId}
          data-testid="git-stashes-toggle"
          onClick={() => setSourceControlCollapsed("stashes", !collapsed)}
        >
          <Chevron className="size-3 shrink-0 text-ink-faint" aria-hidden />
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            Stashes
          </h4>
          <Badge tone="neutral">{snapshot.stashes.length}</Badge>
        </button>
        <button
          type="button"
          className="ml-auto shrink-0 text-[11px] text-ink-faint hover:text-ink disabled:opacity-50"
          aria-label="Stash changes"
          // Stashing with nothing to stash is a no-op git would reject; the
          // button says so rather than failing after the click.
          disabled={snapshot.changed.length === 0}
          title={snapshot.changed.length === 0 ? "Nothing to stash" : "Stash changes"}
          onClick={() => void performGitAction(projectPath, { kind: "stash-push", message: null })}
        >
          Stash changes
        </button>
      </div>

      {collapsed ? null : snapshot.stashes.length === 0 ? (
        <p className="text-[11px] text-ink-faint" id={listId} data-testid="git-stashes-empty">
          No stashes.
        </p>
      ) : (
        <ul className="flex flex-col gap-1" id={listId} data-testid="git-stashes">
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
