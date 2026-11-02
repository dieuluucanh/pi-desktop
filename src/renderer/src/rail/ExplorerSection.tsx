import { useEffect, useMemo, useRef } from "react";
import { Ban, Eye, EyeOff, RefreshCw, Search, X } from "lucide-react";

import { MAX_DIRECTORY_ENTRIES } from "../../../shared/workspace";
import type { ExplorerPrefs } from "../../../shared/explorer-prefs";
import { useEditorStore } from "../editor/editor-store";
import { useAppStore } from "../state/app-store";
import { Button } from "../ui/button";
import { useExplorerStore } from "../files/explorer-store";
import { ExplorerRow } from "./ExplorerRow";
import { ExplorerSearchResults } from "./ExplorerSearchResults";
import { flattenExplorerRows } from "./explorer-view";

/** The file tree body in the rail, with project-wide search. */
export function ExplorerSection({ projectPath }: { projectPath: string }): React.JSX.Element {
  const tree = useExplorerStore((state) => state.trees[projectPath]);
  const search = useExplorerStore((state) => state.searches[projectPath]);
  const setFilter = useExplorerStore((state) => state.setFilter);
  const clearFilter = useExplorerStore((state) => state.clearFilter);
  const searchNow = useExplorerStore((state) => state.searchNow);
  const ensure = useExplorerStore((state) => state.ensure);
  const refresh = useExplorerStore((state) => state.refresh);
  const toggle = useExplorerStore((state) => state.toggle);
  const openFileTab = useEditorStore((state) => state.openFileTab);
  const prefs = useAppStore((state) => state.prefs.explorer);
  const setPrefs = useAppStore((state) => state.setPrefs);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void ensure(projectPath);
  }, [projectPath, ensure]);

  useEffect(() => {
    const onFocus = (): void => void refresh(projectPath);
    window.addEventListener("focus", onFocus);
    const timer = setInterval(() => void refresh(projectPath), 8_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [projectPath, refresh]);

  // A project can be revisited with its query still in the store. Re-run it
  // once on mount/project change; typing itself is debounced by the store.
  useEffect(() => {
    const current = useExplorerStore.getState().searches[projectPath];
    if (current && current.query.trim().length > 0) void searchNow(projectPath);
  }, [projectPath, searchNow]);

  const query = search?.query ?? "";
  const searchActive = query.trim().length > 0;
  const rows = useMemo(
    () =>
      flattenExplorerRows(tree, {
        showHidden: prefs.showHidden,
        showIgnored: prefs.showIgnored,
      }),
    [tree, prefs.showHidden, prefs.showIgnored],
  );

  const clearSearch = (): void => {
    clearFilter(projectPath);
    queueMicrotask(() => inputRef.current?.focus());
  };

  const updatePrefs = (patch: Partial<ExplorerPrefs>): void => {
    setPrefs({ explorer: { ...prefs, ...patch } });
    // The backend needs the new flags; the query itself has not changed.
    if (searchActive) void searchNow(projectPath);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="explorer-section">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search
            className="pointer-events-none absolute left-0 size-3 text-ink-faint"
            aria-hidden
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setFilter(projectPath, event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || query.length === 0) return;
              event.preventDefault();
              event.stopPropagation();
              clearSearch();
            }}
            placeholder="Search files…"
            aria-label="Search files"
            className="w-full min-w-0 bg-transparent pl-4 pr-5 text-[11px] outline-none placeholder:text-ink-faint"
            data-testid="explorer-filter"
          />
          {query.length > 0 ? (
            <button
              type="button"
              aria-label="Clear search"
              title="Clear search"
              className="absolute right-0 rounded-xs p-0.5 text-ink-muted hover:text-ink"
              onClick={clearSearch}
              data-testid="explorer-clear"
            >
              <X className="size-3" aria-hidden />
            </button>
          ) : null}
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={prefs.showHidden ? "Hide hidden files" : "Show hidden files"}
          title={prefs.showHidden ? "Hide hidden files" : "Show hidden files"}
          aria-pressed={prefs.showHidden}
          onClick={() => updatePrefs({ showHidden: !prefs.showHidden })}
        >
          {prefs.showHidden ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={prefs.showIgnored ? "Hide ignored files" : "Show ignored files"}
          title={
            prefs.showIgnored
              ? "Hide files ignored by .gitignore"
              : "Show files ignored by .gitignore"
          }
          aria-pressed={prefs.showIgnored}
          onClick={() => updatePrefs({ showIgnored: !prefs.showIgnored })}
          data-testid="explorer-show-ignored"
        >
          <Ban className={`size-3 ${prefs.showIgnored ? "" : "opacity-40"}`} />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh file tree"
          title="Refresh file tree"
          onClick={() => void refresh(projectPath)}
          data-testid="explorer-refresh"
        >
          <RefreshCw className="size-3" />
        </Button>
      </div>

      {searchActive ? (
        <ExplorerSearchResults
          projectPath={projectPath}
          query={query}
          status={search?.status ?? "idle"}
          results={search?.results ?? []}
          truncated={search?.truncated ?? false}
          scanned={search?.scanned ?? 0}
          error={search?.error ?? null}
          onOpen={(path) => void openFileTab(projectPath, path)}
        />
      ) : (
        <>
          {tree?.error ? <p className="px-3 py-2 text-[11px] text-warn">{tree.error}</p> : null}
          <div className="min-h-0 flex-1 overflow-auto py-1" role="tree" aria-label="File explorer">
            {rows.length === 0 && !tree?.error ? (
              <p className="px-3 py-2 text-[11px] text-ink-faint">
                {tree ? "This folder is empty." : "Reading folder…"}
              </p>
            ) : null}
            {rows.map((row) => (
              <ExplorerRow
                key={row.entry.path}
                projectPath={projectPath}
                row={row}
                onToggle={(path) => toggle(projectPath, path)}
                onOpen={(path) => void openFileTab(projectPath, path)}
              />
            ))}
            {tree?.truncated[""] ? (
              <p className="px-3 py-2 text-[11px] text-ink-faint">
                Showing the first {MAX_DIRECTORY_ENTRIES} entries; some files are not listed.
              </p>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
