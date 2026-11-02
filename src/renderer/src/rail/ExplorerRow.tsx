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
import type { WorkspaceEntryKind } from "../../../shared/workspace";
import { WORKSPACE_PATH_DRAG_VERSION } from "../../../shared/workspace-drag";
import { writeWorkspaceDrag } from "../files/workspace-drag";
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
}

/** One row in the rail's file tree. */
export function ExplorerRow({
  projectPath,
  row,
  onToggle,
  onOpen,
}: ExplorerRowProps): React.JSX.Element {
  const { entry, depth, expanded } = row;
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={entry.kind === "directory" ? expanded : undefined}
      data-testid="explorer-row"
      data-path={entry.path}
      data-depth={depth}
      data-hidden={entry.hidden ? "true" : undefined}
      data-ignored={entry.ignored ? "true" : undefined}
      draggable={!entry.outside}
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
      } ${entry.ignored ? "opacity-60" : ""}`}
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
          <ChevronRight className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
      ) : (
        <span className="w-4 shrink-0" />
      )}
      {entry.kind === "directory" && expanded ? (
        <FolderOpen className="size-3.5 shrink-0 text-info" aria-hidden />
      ) : (
        <EntryIcon path={entry.path} kind={entry.kind} />
      )}
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left"
        onClick={() => {
          if (entry.kind === "directory") onToggle(entry.path);
          else if (!entry.outside) onOpen(entry.path);
        }}
        disabled={entry.outside}
        title={entry.outside ? "Points outside the project" : entry.path}
      >
        {entry.name}
      </button>
      {entry.kind === "file" ? (
        <span className="shrink-0 rounded-xs border border-line px-1 font-mono text-[9px] uppercase text-ink-faint">
          {languageBadge(languageIdForPath(entry.path))}
        </span>
      ) : null}
    </div>
  );
}
