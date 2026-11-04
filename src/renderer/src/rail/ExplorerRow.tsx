import {
  ChevronRight,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";

import { languageBadge, languageIdForPath } from "../../../shared/languages";
import { sameFolder } from "../../../shared/rail-scope";
import type { WorkspaceEntryKind } from "../../../shared/workspace";
import { WORKSPACE_PATH_DRAG_VERSION } from "../../../shared/workspace-drag";
import { useFileClipboardStore } from "../files/file-clipboard-store";
import { writeWorkspaceDrag } from "../files/workspace-drag";
import { ExplorerContextMenu } from "./ExplorerContextMenu";
import { ExplorerInlineInput } from "./ExplorerInlineInput";
import type { ExplorerMenuActionId, ExplorerMenuTarget } from "./explorer-menu";
import type { ExplorerRowModel } from "./explorer-view";

/** The glyph for one explorer entry (also reused by the search result list). */
export function EntryIcon({
  path,
  kind,
}: {
  path: string;
  kind: WorkspaceEntryKind;
}): React.JSX.Element {
  if (kind === "directory") {
    return <Folder className="size-3.5 shrink-0 text-ink-faint" aria-hidden />;
  }
  const language = languageIdForPath(path);
  if (language === "json" || language === "jsonc") {
    return <FileJson className="size-3.5 shrink-0 text-warn" aria-hidden />;
  }
  if (language === "markdown" || language === "mdx" || language === "plaintext") {
    return <FileText className="size-3.5 shrink-0 text-ink-faint" aria-hidden />;
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"].includes(language)) {
    return <FileImage className="size-3.5 shrink-0 text-info" aria-hidden />;
  }
  return <FileCode2 className="size-3.5 shrink-0 text-accent" aria-hidden />;
}

export interface ExplorerRowProps {
  projectPath: string;
  row: ExplorerRowModel;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onAction: (id: ExplorerMenuActionId, target: ExplorerMenuTarget | null) => void;
  renaming?: boolean;
  renameError?: string | null;
  onStartRename: () => void;
  onCommitRename: (name: string) => boolean | Promise<boolean>;
  onCancelRename: () => void;
}

/** One row in the rail's file tree. */
export function ExplorerRow({
  projectPath,
  row,
  onToggle,
  onOpen,
  onAction,
  renaming = false,
  renameError = null,
  onStartRename,
  onCommitRename,
  onCancelRename,
}: ExplorerRowProps): React.JSX.Element {
  const { entry, depth, expanded } = row;
  const clipboard = useFileClipboardStore((state) => state.clipboard);
  const cut =
    clipboard?.mode === "cut" &&
    sameFolder(clipboard.sourceProjectPath, projectPath) &&
    clipboard.paths.some((path) => entry.path === path || entry.path.startsWith(`${path}/`));
  const target: ExplorerMenuTarget = {
    kind: entry.kind,
    path: entry.path,
    name: entry.name,
    outside: entry.outside,
  };

  return (
    <ExplorerContextMenu target={target} onAction={onAction}>
      <div
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={entry.kind === "directory" ? expanded : undefined}
        data-testid="explorer-row"
        data-path={entry.path}
        data-depth={depth}
        data-hidden={entry.hidden ? "true" : undefined}
        data-ignored={entry.ignored ? "true" : undefined}
        data-cut={cut ? "true" : undefined}
        draggable={!entry.outside && !renaming}
        onContextMenu={(event) => event.stopPropagation()}
        onDragStart={(event) => {
          writeWorkspaceDrag(event.dataTransfer, {
            version: WORKSPACE_PATH_DRAG_VERSION,
            projectPath,
            path: entry.path,
            kind: entry.kind,
          });
        }}
        className={`flex h-6 items-center gap-1 pr-2 text-xs hover:bg-raised/60 ${
          entry.hidden ? "text-ink-faint" : "text-ink"
        } ${entry.ignored ? "opacity-60" : ""} ${cut ? "opacity-50" : ""}`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        title={
          entry.hidden
            ? "Hidden file"
            : entry.ignored
              ? "Ignored by .gitignore"
              : entry.kind === "file"
                ? `${entry.path} · ${entry.size ?? 0} bytes`
                : entry.path
        }
      >
        {entry.kind === "directory" ? (
          <button
            type="button"
            aria-label={expanded ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
            className="flex size-4 shrink-0 items-center justify-center text-ink-faint"
            onClick={() => onToggle(entry.path)}
          >
            <ChevronRight
              className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        {entry.kind === "directory" && expanded ? (
          <FolderOpen className="size-3.5 shrink-0 text-info" aria-hidden />
        ) : (
          <EntryIcon path={entry.path} kind={entry.kind} />
        )}
        {renaming ? (
          <ExplorerInlineInput
            value={entry.name}
            ariaLabel={`Rename ${entry.name}`}
            error={renameError}
            className="min-w-0 flex-1"
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left"
            onClick={() => {
              if (entry.kind === "directory") onToggle(entry.path);
              else if (!entry.outside) onOpen(entry.path);
            }}
            onDoubleClick={onStartRename}
            disabled={entry.outside}
            title={entry.outside ? "Points outside the project" : entry.path}
          >
            {entry.name}
          </button>
        )}
        {entry.kind === "file" ? (
          <span className="shrink-0 rounded-xs border border-line px-1 font-mono text-[9px] uppercase text-ink-faint">
            {languageBadge(languageIdForPath(entry.path))}
          </span>
        ) : null}
      </div>
    </ExplorerContextMenu>
  );
}
