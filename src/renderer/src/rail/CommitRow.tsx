/**
 * One Commit History row (commit-history plan step 5).
 *
 * The row is a single 24 px line: icon, subject, then the refs it carries at the
 * right. The author, relative time, short sha and full message live in the hover
 * card, which `ui/hover-card` portals out of the block's scroller.
 */

import { CloudUpload, GitCommit } from "lucide-react";
import { useState } from "react";
import type { GitCommitEntry } from "../../../shared/git";
import { Badge } from "../ui/badge";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card";
import { CommitHoverCard } from "./CommitHoverCard";
import { absoluteTime, commitRowChips } from "./history-view";

/** Long enough not to flash while the pointer crosses the list, short enough to feel live. */
const HOVER_OPEN_MS = 400;
const HOVER_CLOSE_MS = 200;

export interface CommitRowProps {
  entry: GitCommitEntry;
  branch: string | null;
  remotes: readonly string[];
  /** The clock the section captured at mount, so the card's age matches. */
  now: number;
  onOpen: (sha: string) => void;
}

export function CommitRow({ entry, branch, remotes, now, onOpen }: CommitRowProps) {
  const [open, setOpen] = useState(false);
  const { chips, hidden } = commitRowChips(entry, branch, remotes);

  return (
    <li>
      <HoverCard
        open={open}
        onOpenChange={setOpen}
        openDelay={HOVER_OPEN_MS}
        closeDelay={HOVER_CLOSE_MS}
      >
        <HoverCardTrigger asChild>
          <button
            type="button"
            className="flex h-6 w-full min-w-0 items-center gap-1.5 px-3 text-left text-[11px] hover:bg-raised/50"
            data-testid={`commit-${entry.shortSha}`}
            onClick={(event) => {
              setOpen(false);
              // Radix clears its pending openDelay timer on blur; without this the
              // card can reopen over the diff dialog while the read is in flight.
              event.currentTarget.blur();
              onOpen(entry.sha);
            }}
          >
            <GitCommit className="size-3 shrink-0 text-ink-faint" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-ink" data-testid="commit-subject">
              {entry.subject || "(no message)"}
            </span>
            {/* The refs must fit at the 200 px rail floor: `v1.0` + `main` needs
                ~100 px, so 55 % of the row left them ellipsised to `v…`/`ma…`. */}
            <span className="flex min-w-0 max-w-[65%] shrink-0 items-center gap-1 overflow-hidden">
              {chips.map((chip) => (
                <Badge
                  key={chip.key}
                  tone={chip.tone}
                  className="min-w-0 max-w-24 overflow-hidden"
                  data-testid={`commit-ref-${chip.label}`}
                >
                  {chip.local ? null : (
                    <CloudUpload
                      className="size-3 shrink-0 text-info"
                      aria-hidden
                      data-testid={`commit-ref-cloud-${chip.label}`}
                    />
                  )}
                  <span className="min-w-0 truncate">{chip.label}</span>
                  {chip.local && chip.remotes.length > 0 ? (
                    <CloudUpload
                      className="size-3 shrink-0 text-info"
                      aria-hidden
                      data-testid={`commit-ref-cloud-${chip.label}`}
                    />
                  ) : null}
                  {chip.remotes.length > 0 ? (
                    <span className="sr-only">{` on ${chip.remotes.join(", ")}`}</span>
                  ) : null}
                </Badge>
              ))}
              {hidden > 0 ? (
                <span
                  className="shrink-0 text-[10px] text-ink-faint"
                  data-testid="commit-ref-overflow"
                >
                  {`+${hidden}`}
                </span>
              ) : null}
            </span>
            <span className="sr-only">
              {`Commit ${entry.shortSha} by ${entry.author}, ${absoluteTime(entry.at)}`}
            </span>
          </button>
        </HoverCardTrigger>
        <HoverCardContent data-testid={`commit-hover-${entry.shortSha}`}>
          <CommitHoverCard entry={entry} branch={branch} remotes={remotes} now={now} />
        </HoverCardContent>
      </HoverCard>
    </li>
  );
}
