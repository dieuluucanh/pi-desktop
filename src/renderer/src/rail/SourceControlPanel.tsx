/**
 * The Source Control menu body.
 *
 * Three vertically stacked blocks, VS Code's shape, each owning its own scroll
 * container and separated by a draggable splitter:
 *
 * ```text
 *  ┌ source-control-block ─────────────┐  branch row · commit composer · stashes
 *  ├──────── rail-splitter-top ────────┤
 *  ├ changes-block ────────────────────┤  Staged Changes / Changes
 *  ├──────── rail-splitter-middle ─────┤
 *  └ history-block ────────────────────┘  commit log
 * ```
 *
 * Why three blocks rather than one pinned header over one scroller (the previous
 * composition): a long change list pushed the history off the bottom, so
 * scrolling to a commit scrolled the changed files away. Independent scrollers
 * mean neither list can evict the other, and the two splitters let the user say
 * which one they are working in.
 *
 * Two rules this file exists to hold:
 *
 *  - **`scroll: "self"`.** The body declares it to the rail host (see
 *    `SessionView`), because a host-level scroll container would carry the
 *    composer away with the lists.
 *  - **A render-time clamp is never persisted** (plan D2). The split is rendered
 *    through `railSplitFractions`, which clamps for display; only an explicit
 *    gesture — a drag released, a key pressed, a double-click — calls
 *    `setRailSplit`.
 */

import { useRef } from "react";
import { DEFAULT_RAIL_SPLIT } from "../../../shared/rail";
import { useAppStore } from "../state/app-store";
import { BlockSplitter } from "./BlockSplitter";
import { ChangesSection } from "./ChangesSection";
import { CommitBox } from "./CommitBox";
import { GitBranchRow, GitSyncNote, StashList } from "./GitSection";
import { HistorySection } from "./HistorySection";
import { blockFlex, blockTestId } from "./source-control-view";

export interface SourceControlPanelProps {
  /** The folder this panel is showing (a tab's cwd). */
  projectPath: string;
}

export function SourceControlPanel({ projectPath }: SourceControlPanelProps) {
  const split = useAppStore((state) => state.prefs.rail.split);
  const setRailSplit = useAppStore((state) => state.setRailSplit);

  // The drag math needs the body's real height, which only the DOM knows.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const flex = blockFlex(split);

  return (
    <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col" data-testid="source-control-panel">
      {/* Block 1: where am I, what am I committing, how do I move it. */}
      <div
        className="flex min-h-0 flex-col overflow-y-auto"
        style={{ flex: flex[0] }}
        data-testid={blockTestId("source-control")}
      >
        <GitBranchRow projectPath={projectPath} />
        <GitSyncNote projectPath={projectPath} />
        <CommitBox projectPath={projectPath} />
        <div className="border-t border-line">
          <StashList projectPath={projectPath} />
        </div>
      </div>

      <BlockSplitter
        edge="top"
        split={split}
        containerRef={bodyRef}
        label="Resize Source Control and Changes"
        onChange={setRailSplit}
        onReset={() => setRailSplit(DEFAULT_RAIL_SPLIT)}
      />

      {/* Block 2: the working tree. */}
      <div
        className="min-h-0 overflow-y-auto"
        style={{ flex: flex[1] }}
        data-testid={blockTestId("changes")}
      >
        <ChangesSection projectPath={projectPath} />
      </div>

      <BlockSplitter
        edge="middle"
        split={split}
        containerRef={bodyRef}
        label="Resize Changes and Commit History"
        onChange={setRailSplit}
        onReset={() => setRailSplit(DEFAULT_RAIL_SPLIT)}
      />

      {/* Block 3: the log. */}
      <div
        className="min-h-0 overflow-y-auto"
        style={{ flex: flex[2] }}
        data-testid={blockTestId("history")}
      >
        <HistorySection projectPath={projectPath} />
      </div>
    </div>
  );
}
