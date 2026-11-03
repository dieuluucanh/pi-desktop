import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Ban, Eye, EyeOff, Loader2, RefreshCw, Search, X } from "lucide-react";

import type { ExplorerPrefs } from "../../../shared/explorer-prefs";
import {
  MAX_DIRECTORY_ENTRIES,
  workspaceDirname,
  type WorkspaceEntryKind,
} from "../../../shared/workspace";
import { useEditorStore } from "../editor/editor-store";
import { useAppStore } from "../state/app-store";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { useExplorerStore } from "../files/explorer-store";
import { useFileClipboardStore } from "../files/file-clipboard-store";
import {
  addExplorerPathToChat,
  copyExplorerPath,
  createExplorerEntry,
  deleteExplorerEntry,
  pasteExplorerEntries,
  renameExplorerEntry,
  revealExplorerPath,
} from "../files/explorer-ops";
import { EntryIcon, ExplorerRow } from "./ExplorerRow";
import { ExplorerContextMenu } from "./ExplorerContextMenu";
import { ExplorerInlineInput } from "./ExplorerInlineInput";
import { ExplorerSearchResults } from "./ExplorerSearchResults";
import type { ExplorerMenuActionId, ExplorerMenuTarget } from "./explorer-menu";
import { flattenExplorerRows } from "./explorer-view";

interface DraftEntry {
  parentPath: string;
  kind: WorkspaceEntryKind;
}

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
  const busy = useExplorerStore((state) => state.busy[projectPath] === true);
  const lastError = useExplorerStore((state) => state.lastError[projectPath] ?? null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState<DraftEntry | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ExplorerMenuTarget | null>(null);

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

  const expandFolder = (path: string): void => {
    if (path.length === 0) return;
    if (!useExplorerStore.getState().trees[projectPath]?.expanded[path]) {
      toggle(projectPath, path);
    }
  };

  const handleAction = (id: ExplorerMenuActionId, target: ExplorerMenuTarget | null): void => {
    switch (id) {
      case "open":
        if (target) void openFileTab(projectPath, target.path);
        return;
      case "new-file":
      case "new-folder": {
        const parentPath = target
          ? target.kind === "directory"
            ? target.path
            : workspaceDirname(target.path)
          : "";
        expandFolder(parentPath);
        setDraftError(null);
        setDraft({ parentPath, kind: id === "new-file" ? "file" : "directory" });
        return;
      }
      case "add-to-chat":
        if (target) void addExplorerPathToChat(projectPath, target.path, target.kind);
        return;
      case "copy":
        if (target) {
          useFileClipboardStore.getState().copy(projectPath, [target.path]);
          useAppStore.getState().setHint(`Copied ${target.name}.`);
        }
        return;
      case "cut":
        if (target) {
          useFileClipboardStore.getState().cut(projectPath, [target.path]);
          useAppStore.getState().setHint(`Cut ${target.name}.`);
        }
        return;
      case "paste": {
        const targetDirectory = target
          ? target.kind === "directory"
            ? target.path
            : workspaceDirname(target.path)
          : "";
        void pasteExplorerEntries(projectPath, targetDirectory);
        return;
      }
      case "rename":
        if (target) {
          setRenameError(null);
          setRenamingPath(target.path);
        }
        return;
      case "delete":
        if (target) setPendingDelete(target);
        return;
      case "reveal":
        if (target) void revealExplorerPath(projectPath, target.path);
        return;
      case "copy-path":
        if (target) void copyExplorerPath(projectPath, target.path, "absolute");
        return;
      case "copy-relative-path":
        if (target) void copyExplorerPath(projectPath, target.path, "relative");
        return;
      case "refresh":
        void refresh(projectPath);
        return;
    }
  };

  const draftIndex = (() => {
    if (draft === null) return -1;
    if (draft.parentPath.length === 0) return 0;
    const parent = rows.findIndex((row) => row.entry.path === draft.parentPath);
    return parent === -1 ? 0 : parent + 1;
  })();
  const draftDepth = (() => {
    if (draft === null || draft.parentPath.length === 0) return 0;
    const parent = rows.find((row) => row.entry.path === draft.parentPath);
    return parent ? parent.depth + 1 : 0;
  })();

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
        {busy ? (
          <Loader2 className="size-3 animate-spin text-ink-faint" aria-label="Working" />
        ) : null}
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

      {lastError ? (
        <p className="px-3 py-1 text-[11px] text-warn" data-testid="explorer-error">
          {lastError}
        </p>
      ) : null}

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
          onAction={handleAction}
        />
      ) : (
        <>
          {tree?.error ? <p className="px-3 py-2 text-[11px] text-warn">{tree.error}</p> : null}
          <ExplorerContextMenu target={null} onAction={handleAction}>
            <div
              className="min-h-0 flex-1 overflow-auto py-1"
              role="tree"
              aria-label="File explorer"
              data-testid="explorer-tree"
            >
              {rows.length === 0 && !tree?.error ? (
                <p className="px-3 py-2 text-[11px] text-ink-faint">
                  {tree ? "This folder is empty." : "Reading folder…"}
                </p>
              ) : null}
              {rows.map((row, index) => (
                <Fragment key={row.entry.path}>
                  {draft && index === draftIndex ? (
                    <DraftRow
                      kind={draft.kind}
                      depth={draftDepth}
                      error={draftError}
                      onCancel={() => {
                        setDraft(null);
                        setDraftError(null);
                      }}
                      onCommit={async (name) => {
                        const ok = await createExplorerEntry(
                          projectPath,
                          draft.parentPath,
                          name,
                          draft.kind,
                        );
                        if (ok) {
                          setDraft(null);
                          setDraftError(null);
                        } else {
                          setDraftError(
                            useExplorerStore.getState().lastError[projectPath] ??
                              "Could not create the entry.",
                          );
                        }
                        return ok;
                      }}
                    />
                  ) : null}
                  <ExplorerRow
                    projectPath={projectPath}
                    row={row}
                    onToggle={(path) => toggle(projectPath, path)}
                    onOpen={(path) => void openFileTab(projectPath, path)}
                    onAction={handleAction}
                    renaming={renamingPath === row.entry.path}
                    renameError={renamingPath === row.entry.path ? renameError : null}
                    onStartRename={() => {
                      setRenameError(null);
                      setRenamingPath(row.entry.path);
                    }}
                    onCommitRename={async (name) => {
                      const ok = await renameExplorerEntry(projectPath, row.entry.path, name);
                      if (ok) {
                        setRenamingPath(null);
                        setRenameError(null);
                      } else {
                        setRenameError(
                          useExplorerStore.getState().lastError[projectPath] ??
                            "Could not rename the entry.",
                        );
                      }
                      return ok;
                    }}
                    onCancelRename={() => {
                      setRenamingPath(null);
                      setRenameError(null);
                    }}
                  />
                </Fragment>
              ))}
              {draft && draftIndex >= rows.length ? (
                <DraftRow
                  kind={draft.kind}
                  depth={draftDepth}
                  error={draftError}
                  onCancel={() => {
                    setDraft(null);
                    setDraftError(null);
                  }}
                  onCommit={async (name) => {
                    const ok = await createExplorerEntry(
                      projectPath,
                      draft.parentPath,
                      name,
                      draft.kind,
                    );
                    if (ok) {
                      setDraft(null);
                      setDraftError(null);
                    } else {
                      setDraftError(
                        useExplorerStore.getState().lastError[projectPath] ??
                          "Could not create the entry.",
                      );
                    }
                    return ok;
                  }}
                />
              ) : null}
              {tree?.truncated[""] ? (
                <p className="px-3 py-2 text-[11px] text-ink-faint">
                  Showing the first {MAX_DIRECTORY_ENTRIES} entries; some files are not listed.
                </p>
              ) : null}
            </div>
          </ExplorerContextMenu>
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Move to Recycle Bin?"
        description={
          pendingDelete
            ? `"${pendingDelete.path}" will be moved to the OS Recycle Bin/Trash and can be restored there.`
            : ""
        }
        confirmLabel="Move to Recycle Bin"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) {
            void deleteExplorerEntry(projectPath, target.path, target.kind);
          }
        }}
      />
    </div>
  );
}

function DraftRow({
  kind,
  depth,
  error,
  onCommit,
  onCancel,
}: {
  kind: WorkspaceEntryKind;
  depth: number;
  error: string | null;
  onCommit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      data-testid="explorer-draft-row"
      className="flex h-6 items-center gap-1 pr-2 text-xs"
      style={{ paddingLeft: `${depth * 14 + 6}px` }}
    >
      <span className="w-4 shrink-0" />
      <EntryIcon path="" kind={kind} />
      <ExplorerInlineInput
        placeholder={kind === "file" ? "New file name" : "New folder name"}
        ariaLabel={kind === "file" ? "New file name" : "New folder name"}
        error={error}
        className="min-w-0 flex-1"
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
}
