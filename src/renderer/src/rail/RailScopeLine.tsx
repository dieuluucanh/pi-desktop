/**
 * The rail's scope line.
 *
 * One 11 px row under the panel title, naming **what this menu acts on**, with a
 * way to get there. It lives in the rail host (`RightRail`) rather than in a body
 * so it stays pinned for menus that scroll: Checkpoints' list must not be able to
 * carry the answer to "which folder?" off the top of the column.
 *
 * ```text
 *  ▸ Source Control
 *  [folder] danone-hcm            Go to project
 *  ─────────────────────────────────────────
 *  (body)
 * ```
 *
 * The name is the folder's last segment (a full path does not fit at 320 px); the
 * full path is the `title`, so hover still answers "which one exactly".
 */

import type { ReactNode } from "react";
import { FolderGit2 } from "lucide-react";
import { Button } from "../ui/button";
import { projectScopeLabel } from "./scope-view";

export interface RailScopeLineProps {
  /** The folder this menu is scoped to (the active session's cwd). */
  projectPath: string;
  /** Focus the session/project that owns this folder. */
  onGoToProject: () => void;
  /** A second row supplied by the menu (Documents uses it for the host facts). */
  trailing?: ReactNode;
}

export function RailScopeLine({
  projectPath,
  onGoToProject,
  trailing,
}: RailScopeLineProps): React.JSX.Element | null {
  const label = projectScopeLabel({ path: projectPath });
  if (!label) return null;

  return (
    <div
      className="flex shrink-0 flex-col gap-1 border-b border-line px-3 py-1 text-[11px]"
      data-testid="rail-scope"
    >
      <div className="flex items-center gap-1.5">
        <FolderGit2 className="size-3 shrink-0 text-ink-faint" aria-hidden />
        <span
          className="min-w-0 flex-1 truncate text-ink-muted"
          title={label.title}
          data-testid="rail-scope-path"
        >
          {label.name}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 shrink-0 px-1 text-[11px] text-ink-faint hover:text-ink"
          aria-label="Go to project"
          title={label.path}
          onClick={onGoToProject}
        >
          Go to project
        </Button>
      </div>
      {trailing}
    </div>
  );
}
