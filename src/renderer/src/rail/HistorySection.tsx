/**
 * The History section (git-checkpoint plan step 15).
 *
 * One page of commits (30, the same window main defaults to), a *Load more*
 * cursor, and a click that opens the commit's diff in the shared viewer. The
 * row carries the four facts a person needs to identify a commit: subject,
 * author, relative time and short sha — plus the branch/tag chips when the
 * commit carries them.
 */

import { useEffect, useState } from "react";
import { GitCommit } from "lucide-react";
import { gitUnavailableMessage } from "../../../shared/git";
import { Badge } from "../ui/badge";
import { useAppStore } from "../state/app-store";
import { absoluteTime, commitChips, historyKey, relativeTime } from "./history-view";
import { RailBlockHeader } from "./RailBlockHeader";

export interface HistorySectionProps {
  projectPath: string;
}

/** How many commits the section loads per page (matches main's default). */
export const HISTORY_PAGE_SIZE = 30;

export function HistorySection({ projectPath }: HistorySectionProps) {
  const snapshot = useAppStore((state) => state.git[projectPath]);
  const page = useAppStore((state) => state.gitLog[projectPath]);
  const loadGitLog = useAppStore((state) => state.loadGitLog);
  const openGitDiff = useAppStore((state) => state.openGitDiff);

  // The clock is captured once, in a lazy initializer: reading `Date.now()`
  // during render is impure, and a frozen "now" is the right behaviour anyway —
  // relative times should not jitter on every unrelated re-render. It sits above
  // the early returns so the hook order never changes.
  const [now] = useState(() => Date.now());

  // The section only mounts while it is expanded, so mounting is the signal to
  // load the first page. The page is keyed to the repo state it was read for:
  // a new commit, fetch, push or branch switch changes the key and the list
  // reloads itself, including after the section was unmounted.
  const repo = snapshot?.repo;
  const key = historyKey(repo);
  const loadedKey = page?.key ?? null;
  useEffect(() => {
    if (snapshot?.available !== true || key === null || loadedKey === key) return;
    void loadGitLog(projectPath, { key });
  }, [snapshot?.available, key, loadedKey, projectPath, loadGitLog]);

  const available = snapshot?.available === true;
  const entries = page?.entries ?? [];

  // The header is pinned and always present: the rail's third block must not
  // become an unlabelled void when git is unavailable (2026-10-30 rail-headers
  // plan). Only the reason for the empty log changes.
  const count =
    available && entries.length > 0 ? `${entries.length}${page?.hasMore ? "+" : ""}` : undefined;

  return (
    <div className="flex flex-col pb-2" data-testid="history-section">
      <RailBlockHeader
        title="Commit History"
        testId="history-header"
        {...(count === undefined ? {} : { count, countTestId: "history-count" })}
        {...(available
          ? {
              onRefresh: () => void loadGitLog(projectPath, { key }),
              refreshLabel: "Refresh commit history",
            }
          : {})}
      />

      {snapshot === undefined ? (
        <p className="px-3 py-2 text-[11px] text-ink-faint" data-testid="history-empty">
          Loading commit history…
        </p>
      ) : !available ? (
        <p className="px-3 py-2 text-[11px] text-ink-faint" data-testid="history-empty">
          {gitUnavailableMessage(snapshot.reason ?? "not_a_repo")}
        </p>
      ) : snapshot.repo?.empty ? (
        <p className="px-3 py-2 text-[11px] text-ink-faint" data-testid="history-empty">
          No commits yet.
        </p>
      ) : entries.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-ink-faint" data-testid="history-empty">
          {page?.loading ? "Loading commits…" : "No commits to show."}
        </p>
      ) : (
        <ul className="flex flex-col">
          {entries.map((entry) => (
            <li key={entry.sha}>
              <button
                type="button"
                className="flex w-full flex-col gap-0.5 px-3 py-1 text-left text-[11px] hover:bg-raised/50"
                data-testid={`commit-${entry.shortSha}`}
                title={absoluteTime(entry.at)}
                onClick={() => void openGitDiff(projectPath, { commit: entry.sha })}
              >
                <span className="flex items-center gap-1">
                  <GitCommit className="size-3 shrink-0 text-ink-faint" aria-hidden />
                  <span
                    className="min-w-0 flex-1 truncate font-medium text-ink"
                    title={entry.subject}
                  >
                    {entry.subject || "(no message)"}
                  </span>
                </span>
                <span className="flex items-center gap-1 pl-4 text-ink-faint">
                  <span className="font-mono">{entry.shortSha}</span>
                  <span className="min-w-0 flex-1 truncate">{entry.author}</span>
                  <span className="shrink-0">{relativeTime(entry.at, now)}</span>
                </span>
                {commitChips(entry).length > 0 ? (
                  <span className="flex flex-wrap gap-1 pl-4">
                    {commitChips(entry).map((chip) => (
                      <Badge
                        key={chip}
                        tone={chip === snapshot.repo?.branch ? "accent" : "neutral"}
                      >
                        {chip}
                      </Badge>
                    ))}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      {available && page?.hasMore ? (
        <button
          type="button"
          className="mx-3 mt-1 self-start text-[11px] text-ink-faint underline hover:text-ink"
          disabled={page.loading}
          onClick={() => void loadGitLog(projectPath, { more: true })}
        >
          {page.loading ? "Loading…" : `Load ${HISTORY_PAGE_SIZE} more`}
        </button>
      ) : null}
    </div>
  );
}
