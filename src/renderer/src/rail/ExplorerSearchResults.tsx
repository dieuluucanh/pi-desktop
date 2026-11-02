import type { WorkspaceSearchMatch } from "../../../shared/workspace";
import { WORKSPACE_PATH_DRAG_VERSION } from "../../../shared/workspace-drag";
import { writeWorkspaceDrag } from "../files/workspace-drag";
import { EntryIcon } from "./ExplorerRow";
import type { ExplorerSearchStatus } from "../files/explorer-store";

export interface ExplorerSearchResultsProps {
  projectPath: string;
  query: string;
  status: ExplorerSearchStatus;
  results: readonly WorkspaceSearchMatch[];
  truncated: boolean;
  scanned: number;
  error: string | null;
  onOpen: (path: string) => void;
}

/**
 * The flat result list shown while an Explorer query is active. It is a list of
 * buttons (not a tree) because a match can be any depth down and the folder
 * hierarchy is already represented by the dimmed directory column.
 */
export function ExplorerSearchResults({
  projectPath,
  query,
  status,
  results,
  truncated,
  scanned,
  error,
  onOpen,
}: ExplorerSearchResultsProps): React.JSX.Element {
  return (
    <div
      className="min-h-0 flex-1 overflow-auto py-1"
      data-testid="explorer-search-results"
      aria-label="File search results"
    >
      <p className="sr-only" aria-live="polite">
        {status === "ready" ? `${results.length} files match.` : ""}
      </p>
      {status === "error" ? <p className="px-3 py-2 text-[11px] text-warn">{error}</p> : null}
      {(status === "loading" || status === "idle") && results.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-ink-faint">Searching…</p>
      ) : null}
      {status === "ready" && results.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-ink-faint">No files match “{query}”.</p>
      ) : null}
      {results.length > 0 ? (
        <div role="list">
          {results.map((match) => (
            <div key={match.path} role="listitem">
              <button
                type="button"
                data-testid="explorer-result"
                data-path={match.path}
                title={match.path}
                draggable
                onDragStart={(event) => {
                  writeWorkspaceDrag(event.dataTransfer, {
                    version: WORKSPACE_PATH_DRAG_VERSION,
                    projectPath,
                    path: match.path,
                    kind: "file",
                  });
                }}
                onClick={() => onOpen(match.path)}
                className="flex h-6 w-full items-center gap-1 px-2 text-left text-xs hover:bg-raised/60"
              >
                <EntryIcon path={match.path} kind="file" />
                <span className="min-w-0 flex-1 truncate text-ink">{match.name}</span>
                {match.directory.length > 0 ? (
                  <span className="max-w-[45%] shrink-0 truncate text-[10px] text-ink-faint">
                    {match.directory}
                  </span>
                ) : null}
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {truncated ? (
        <p className="px-3 py-2 text-[11px] text-ink-faint">
          Showing the first {results.length} matches (scanned {scanned} files); refine the search to
          narrow it.
        </p>
      ) : null}
    </div>
  );
}
