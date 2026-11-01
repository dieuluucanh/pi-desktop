/**
 * The commit hover card (commit-history plan step 4).
 *
 * VS Code's commit hover, in the rail's vocabulary: the full message (subject
 * and body) as selectable text, every decoration git reported, the author, the
 * absolute and relative date, the full sha, and the two copy actions. The card
 * is rendered inside `ui/hover-card`, which portals it out of the History
 * block's scroller and keeps it open while the user drags a selection.
 */

import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { GitCommitEntry } from "../../../shared/git";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { copyText } from "../ui/clipboard";
import {
  absoluteTime,
  commitChipTone,
  commitRefs,
  fullCommitMessage,
  relativeTime,
} from "./history-view";

export interface CommitHoverCardProps {
  entry: GitCommitEntry;
  branch: string | null | undefined;
  remotes: readonly string[];
  /** The clock the section captured at mount, so the age matches the row. */
  now: number;
}

type CopyStatus = "idle" | "copied" | "failed";

/** A copy button that reports its own outcome and resets after 1.5 s. */
function CopyAction({ text, label, testId }: { text: string; label: string; testId: string }) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const run = () => {
    void copyText(text).then((ok) => {
      setStatus(ok ? "copied" : "failed");
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setStatus("idle"), 1_500);
    });
  };

  const Icon = status === "copied" ? Check : status === "failed" ? X : Copy;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 px-1.5 text-[10px]"
      data-testid={testId}
      disabled={text.length === 0}
      onClick={run}
    >
      <Icon className="size-3" aria-hidden />
      <span aria-live="polite">
        {status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : label}
      </span>
    </Button>
  );
}

export function CommitHoverCard({ entry, branch, remotes, now }: CommitHoverCardProps) {
  const refs = commitRefs(entry);
  const message = fullCommitMessage(entry);

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex min-w-0 items-center gap-1 text-[11px]"
        data-testid={`commit-byline-${entry.shortSha}`}
      >
        <span className="min-w-0 truncate font-medium text-ink">{entry.author}</span>
        <span className="shrink-0 text-ink-faint" aria-hidden>
          ·
        </span>
        <span className="shrink-0 text-ink-muted">{absoluteTime(entry.at)}</span>
        <span className="shrink-0 text-ink-faint">({relativeTime(entry.at, now)})</span>
      </div>

      <div
        className="select-text whitespace-pre-wrap break-words text-[11px] leading-4"
        data-testid={`commit-message-${entry.shortSha}`}
      >
        {entry.subject ? <span className="font-medium text-ink">{entry.subject}</span> : null}
        {entry.body ? (
          <span className="text-ink-muted">
            {entry.subject ? "\n\n" : ""}
            {entry.body}
          </span>
        ) : null}
        {!entry.subject && !entry.body ? (
          <span className="text-ink-muted">(no message)</span>
        ) : null}
      </div>

      {refs.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {refs.map((ref) => (
            <Badge
              key={ref}
              tone={commitChipTone(ref, branch, remotes)}
              data-testid={`commit-hover-ref-${ref}`}
            >
              {ref}
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-1 border-t border-line pt-1.5">
        <div
          className="select-all break-all font-mono text-[10px] leading-4 text-ink-muted"
          data-testid={`commit-hover-sha-${entry.shortSha}`}
        >
          {entry.sha}
        </div>
        <div className="flex items-center gap-1">
          <CopyAction
            text={entry.sha}
            label="Copy hash"
            testId={`commit-copy-hash-${entry.shortSha}`}
          />
          <CopyAction
            text={message}
            label="Copy message"
            testId={`commit-copy-message-${entry.shortSha}`}
          />
        </div>
      </div>
    </div>
  );
}
