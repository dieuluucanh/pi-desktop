import { useEffect, useMemo, useState } from "react";
import { FolderOpen, Pencil, Play, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { CopyIconButton } from "../ui/copy-button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { useAppStore } from "../state/app-store";
import {
  formatSessionTime,
  formatSessionTimeTitle,
  groupSessionsByProject,
  normalizeSessionListQuery,
  sameSessionListQuery,
  sessionDisplayTitle,
  type SessionSummary,
} from "../../../shared/session-browser";

/**
 * The session browser (plan step 11, deliverable `SessionBrowserView`).
 *
 * Pi's profile already holds every session of every project; this dialog is the
 * view onto it (`session.list` on the **control host** → `SessionManager.listAll`).
 * Sessions are grouped by project, searchable by title/first message/path and
 * ordered by recency, with resume, rename, delete-to-trash and "continue the most
 * recent session" per project.
 *
 * It is a dialog rather than a full-page view so the command palette, the menu
 * and `/resume` all front the same surface (plan D-A4).
 */

export function SessionBrowserDialog() {
  const open = useAppStore((state) => state.sessionBrowserOpen);
  const close = useAppStore((state) => state.closeSessionBrowser);
  const query = useAppStore((state) => state.sessionBrowserQuery);
  const setQuery = useAppStore((state) => state.setSessionBrowserQuery);
  const sessions = useAppStore((state) => state.projectSessions);
  const loaded = useAppStore((state) => state.projectSessionsLoaded);
  const error = useAppStore((state) => state.projectSessionsError);
  const errorKind = useAppStore((state) => state.projectSessionsErrorKind);
  const searching = useAppStore((state) => state.projectSessionsSearching);
  const total = useAppStore((state) => state.projectSessionsTotal);
  const matched = useAppStore((state) => state.projectSessionsMatched);
  const truncated = useAppStore((state) => state.projectSessionsTruncated);
  const resume = useAppStore((state) => state.resumeSession);
  const remove = useAppStore((state) => state.deleteSession);
  const rename = useAppStore((state) => state.renameStoredSession);
  const continueRecent = useAppStore((state) => state.continueMostRecent);
  const refresh = useAppStore((state) => state.loadProjectSessions);
  const create = useAppStore((state) => state.createSessionTab);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  // Scope/sort/toggles mirror terminal Pi's session selector (plan step 16). The
  // store owns them so the tab, the request and the recorded query cannot drift.
  const scope = useAppStore((state) => state.sessionBrowserScope);
  const sort = useAppStore((state) => state.sessionBrowserSort);
  const namedOnly = useAppStore((state) => state.sessionBrowserNamedOnly);
  const setScope = useAppStore((state) => state.setSessionBrowserScope);
  const setSort = useAppStore((state) => state.setSessionBrowserSort);
  const setNamedOnly = useAppStore((state) => state.setSessionBrowserNamedOnly);
  const recordedQuery = useAppStore((state) => state.projectSessionsQuery);
  const [showPath, setShowPath] = useState(false);
  const activeCwd = useAppStore((state) => state.project?.path ?? null);
  const tabs = useAppStore((state) => state.tabs);
  // The host owns filtering/search/sort (it has the full message text and a
  // short catalog cache), so the dialog debounces instead of filtering locally.
  // `openSessionBrowser` records the query it loaded, so opening never duplicates.
  const composed = useMemo(
    () => normalizeSessionListQuery({ query, scope, cwd: activeCwd, sort, namedOnly }),
    [query, scope, activeCwd, sort, namedOnly],
  );
  useEffect(() => {
    if (!open) return;
    if (sameSessionListQuery(composed, recordedQuery)) return;
    const timer = setTimeout(() => void refresh(composed), 150);
    return () => clearTimeout(timer);
  }, [open, composed, recordedQuery, refresh]);

  const groups = useMemo(() => groupSessionsByProject(sessions), [sessions]);

  /** Tabs that point at this file; deleting it closes them (the store does it). */
  const openTabsFor = (sessionPath: string): string[] =>
    tabs
      .filter((tab) => tab.kind !== "web" && tab.sessionFile === sessionPath)
      .map((tab) => tab.title);

  const nextSort = (): void =>
    setSort(sort === "recent" ? "threaded" : sort === "threaded" ? "relevance" : "recent");

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent
        className="flex max-h-[74vh] flex-col"
        aria-describedby={undefined}
        data-testid="session-browser"
      >
        <DialogTitle>Sessions</DialogTitle>
        <DialogDescription>
          {scope === "current"
            ? "Sessions saved for this project, newest first. Resuming one opens it in a new tab."
            : "Every session in this Pi profile, newest first. Resuming one opens it in a new tab."}
        </DialogDescription>

        <div className="flex items-center gap-2 px-4 pb-2">
          <label className="flex flex-1 items-center gap-2 rounded-sm border border-line bg-raised px-2 py-1.5">
            <Search className="size-3.5 text-ink-faint" aria-hidden />
            <input
              aria-label="Search sessions"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title, first message or path…"
              className="w-full bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
            />
          </label>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Refresh session list"
            title="Refresh"
            onClick={() => void refresh({ ...composed, refresh: true })}
          >
            <RefreshCw className="size-3.5" aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            title="New session in the background project"
            onClick={() => {
              close();
              void create();
            }}
          >
            <Plus className="size-3.5" aria-hidden />
            New session
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1 px-4 pb-2 text-[11px]">
          <div
            className="flex rounded-sm border border-line p-0.5"
            role="tablist"
            aria-label="Scope"
          >
            {(["all", "current"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={scope === value}
                className={cn(
                  "rounded-xs px-2 py-0.5",
                  scope === value ? "bg-accent/15 text-accent" : "text-ink-muted hover:text-ink",
                )}
                onClick={() => setScope(value)}
              >
                {value === "all" ? "All sessions" : "This project"}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="rounded-sm border border-line px-2 py-0.5 text-ink-muted hover:text-ink"
            title="Cycle the sort order"
            onClick={nextSort}
            data-testid="session-sort"
          >
            sort: {sort}
          </button>
          <button
            type="button"
            aria-pressed={namedOnly}
            className={cn(
              "rounded-sm border border-line px-2 py-0.5",
              namedOnly ? "bg-accent/15 text-accent" : "text-ink-muted hover:text-ink",
            )}
            onClick={() => setNamedOnly(!namedOnly)}
          >
            named only
          </button>
          <button
            type="button"
            aria-pressed={showPath}
            className={cn(
              "rounded-sm border border-line px-2 py-0.5",
              showPath ? "bg-accent/15 text-accent" : "text-ink-muted hover:text-ink",
            )}
            onClick={() => setShowPath((value) => !value)}
          >
            show path
          </button>
          <span className="ml-auto text-ink-faint">
            <span className="font-mono">re:</span> regex ·{" "}
            <span className="font-mono">"phrase"</span> · words = all must match
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4" data-testid="session-list">
          {searching ? (
            <p className="mb-1 text-[10px] text-ink-faint" data-testid="session-searching">
              Searching…
            </p>
          ) : null}
          {error && errorKind === "query" ? (
            <div className="banner banner--error mb-2" role="alert">
              Invalid regular expression: {error}
            </div>
          ) : null}
          {error && errorKind !== "query" ? (
            <div className="banner banner--error mb-2" role="alert">
              {error}
            </div>
          ) : null}
          {!loaded ? <p className="py-6 text-center text-xs text-ink-muted">Loading…</p> : null}
          {loaded && !error && sessions.length === 0 ? (
            <div className="py-6 text-center text-xs text-ink-muted">
              <p>
                {total === 0
                  ? "No sessions yet — start one with Ctrl+N."
                  : scope === "current" && query.length === 0
                    ? "No sessions in this project yet."
                    : "No session matches that search."}
              </p>
              {scope === "current" && query.length === 0 && total > 0 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  onClick={() => setScope("all")}
                >
                  Show all sessions
                </Button>
              ) : null}
            </div>
          ) : null}
          {loaded && !error && truncated ? (
            <p className="mb-2 text-[10px] text-ink-faint" data-testid="session-truncated">
              Showing {sessions.length} of {matched} matches — narrow the search.
            </p>
          ) : null}

          {groups.map((group) => (
            <section key={group.cwd || "(none)"} className="mb-4">
              <div className="flex items-center gap-2 py-1">
                <FolderOpen className="size-3.5 text-ink-faint" aria-hidden />
                <span className="text-xs font-semibold text-ink">{group.name}</span>
                {group.cwd ? (
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
                    {group.cwd}
                  </span>
                ) : (
                  <span className="flex-1" />
                )}
                <span className="text-[10px] text-ink-faint">{group.sessions.length}</span>
                {group.cwd ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Continue the most recent session in this project"
                    onClick={() => void continueRecent(group.cwd)}
                  >
                    <Play className="size-3" aria-hidden />
                    Continue
                  </Button>
                ) : null}
              </div>

              <ul className="flex flex-col gap-1">
                {group.sessions.map((session) => (
                  <SessionRow
                    key={session.path}
                    session={session}
                    renaming={renamingPath === session.path}
                    pendingDelete={pendingDelete === session.path}
                    onStartRename={() => setRenamingPath(session.path)}
                    onCancelRename={() => setRenamingPath(null)}
                    onRename={(name) => {
                      setRenamingPath(null);
                      void rename(session, name);
                    }}
                    showPath={showPath}
                    openTabs={openTabsFor(session.path)}
                    onResume={() => void resume(session)}
                    onAskDelete={() => setPendingDelete(session.path)}
                    onCancelDelete={() => setPendingDelete(null)}
                    onDelete={() => {
                      setPendingDelete(null);
                      void remove(session);
                    }}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SessionRow({
  session,
  showPath,
  openTabs,
  renaming,
  pendingDelete,
  onStartRename,
  onCancelRename,
  onRename,
  onResume,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  session: SessionSummary;
  /** Show the full JSONL path under the row title instead of just the id. */
  showPath: boolean;
  /** Titles of open tabs that deleting this file will close. */
  openTabs: readonly string[];
  renaming: boolean;
  pendingDelete: boolean;
  onStartRename: () => void;
  onCancelRename: () => void;
  onRename: (name: string) => void;
  onResume: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      className="flex items-center gap-2 rounded-sm border border-line bg-raised/40 px-2 py-1.5"
      data-testid="session-row"
    >
      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            autoFocus
            aria-label="New session name"
            defaultValue={session.name ?? sessionDisplayTitle(session)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onRename(event.currentTarget.value);
              if (event.key === "Escape") onCancelRename();
            }}
            onBlur={(event) => onRename(event.target.value)}
            className="w-full rounded-xs border border-line bg-surface px-1.5 py-0.5 text-xs text-ink outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={onResume}
            className="block w-full truncate text-left text-xs text-ink hover:text-accent"
            title={session.path}
          >
            {sessionDisplayTitle(session)}
          </button>
        )}
        <div className="flex gap-2 text-[10px] text-ink-faint">
          <time title={formatSessionTimeTitle(session.modified)}>
            {formatSessionTime(session.modified)}
          </time>
          <span>{session.messageCount} messages</span>
          {showPath ? (
            <span className="truncate font-mono" title={session.path}>
              {session.path}
            </span>
          ) : (
            <span className="truncate font-mono">{session.id}</span>
          )}
        </div>
      </div>

      {pendingDelete ? (
        <span className="flex items-center gap-1">
          <span className="text-[10px] text-danger" title={openTabs.join(", ")}>
            {openTabs.length > 0
              ? `Move to trash? Closes ${openTabs.length === 1 ? `"${openTabs[0]}"` : `${openTabs.length} open tabs`}.`
              : "Move to trash?"}
          </span>
          <Button size="sm" variant="ghost" onClick={onCancelDelete}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete}>
            Delete
          </Button>
        </span>
      ) : (
        <span className="flex items-center gap-1">
          <Button size="sm" variant="ghost" aria-label="Resume session" onClick={onResume}>
            <Play className="size-3" aria-hidden />
          </Button>
          <Button size="sm" variant="ghost" aria-label="Rename session" onClick={onStartRename}>
            <Pencil className="size-3" aria-hidden />
          </Button>
          <CopyIconButton
            value={session.path}
            label="Copy session path"
            title={session.path}
            testId="session-copy-path"
          />
          <Button size="sm" variant="ghost" aria-label="Delete session" onClick={onAskDelete}>
            <Trash2 className="size-3" aria-hidden />
          </Button>
        </span>
      )}
    </li>
  );
}
