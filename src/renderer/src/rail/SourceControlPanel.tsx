/**
 * The Source Control menu body.
 *
 * One panel in VS Code's source-control order (the user's words: *commit message
 * composer first, Fetch/Pull/Push second, then Changes, Stashes, History*):
 *
 * ```text
 *  branch line          (pinned)
 *  commit composer      (pinned)
 *  Fetch · Pull · Push  (pinned)
 *  ──────────────────────────────────  scrolls
 *  Staged Changes / Changes
 *  Stashes
 *  History
 * ```
 *
 * The split between pinned and scrolling is the point of the composition: the
 * place you write a message and the verbs you press stay in view while a long
 * change list or commit log scrolls beneath them. The locked region is
 * `shrink-0` and the scrolling one is `min-h-0 flex-1 overflow-y-auto`, which is
 * why this body declares `scroll: "self"` to the rail host — a host-level scroll
 * container would carry the composer away with everything else.
 */

import { GitBranchBar, GitSyncRow, StashList } from "./GitSection";
import { ChangesSection } from "./ChangesSection";
import { CommitBox } from "./CommitBox";
import { HistorySection } from "./HistorySection";

export interface SourceControlPanelProps {
  /** The folder this panel is showing (a tab's cwd). */
  projectPath: string;
}

export function SourceControlPanel({ projectPath }: SourceControlPanelProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="source-control-panel">
      {/* Pinned: where am I, what am I committing, how do I move it. */}
      <div className="flex shrink-0 flex-col border-b border-line">
        <GitBranchBar projectPath={projectPath} />
        <CommitBox projectPath={projectPath} />
        <GitSyncRow projectPath={projectPath} />
      </div>

      {/* Scrolling: the working tree, the stashes, the log. */}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="source-control-scroll">
        <ChangesSection projectPath={projectPath} />
        <div className="border-t border-line">
          <StashList projectPath={projectPath} />
        </div>
        <div className="border-t border-line">
          <HistorySection projectPath={projectPath} />
        </div>
      </div>
    </div>
  );
}
