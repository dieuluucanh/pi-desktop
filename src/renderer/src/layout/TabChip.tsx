import type { DragEvent } from "react";
import { Globe, Pin, X } from "lucide-react";

import { SESSION_STATUS_LABEL, type TabRecord, type TabStatus } from "../../../shared/session-ipc";
import { languageBadge, languageIdForPath } from "../../../shared/languages";
import { useEditorStore } from "../editor/editor-store";
import { InlineRename } from "../ui/inline-rename";
import { TabContextMenu } from "./TabMenu";
import { openTabContextMenuFromKeyboard } from "./tab-menu-keyboard";

/**
 * One tab chip, shared by the session and editor strips.
 *
 * The chip owns the visual identity of every kind — session status dot, web
 * globe, editor language badge + dirty dot — and the lifecycle controls
 * (context menu, close). There is deliberately no per-chip overflow button:
 * right-click opens the same menu, and `Shift+F10` / the Menu key opens it from
 * the keyboard, so the title gets the width instead of sharing it with duplicate
 * chrome.
 *
 * Drag state and ordering belong to `TabList`, because reordering is a property
 * of the whole strip.
 *
 * The dirty flag is subscribed per chip instead of receiving the whole
 * `editorMeta` object, so a cursor move in one file does not re-render the strip.
 */

const STATUS_DOT: Record<TabStatus, string> = {
  starting: "bg-warn",
  idle: "bg-ok",
  running: "bg-accent",
  crashed: "bg-danger",
  failed: "bg-danger",
  stopped: "bg-ink-faint",
};

export interface TabChipProps {
  tab: TabRecord;
  active: boolean;
  dragging: boolean;
  renaming: boolean;
  onActivate: () => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onCommitRename: (name: string) => void;
  /**
   * Starts a drag. The event is passed so the strip can also publish the typed
   * `application/x-pi-tab` payload a grid pane accepts (2026-11-03 plan);
   * reordering still works off the strip's own `dragId`.
   */
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onClose: () => void;
}

export function TabChip({
  tab,
  active,
  dragging,
  renaming,
  onActivate,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onClose,
}: TabChipProps): React.JSX.Element {
  const dirty = useEditorStore((state) => state.meta[tab.id]?.dirty === true);
  const pinned = tab.pinned === true;

  return (
    <TabContextMenu tab={tab} onRename={onStartRename}>
      <div
        draggable={!renaming}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onKeyDown={openTabContextMenuFromKeyboard}
        className={`flex h-7 items-center gap-1 rounded-sm border px-2 text-xs ${
          active ? "border-line-strong bg-surface" : "border-transparent bg-transparent"
        } ${dragging ? "opacity-60" : ""}`}
        data-testid={`tab-${tab.id}`}
        data-tab-id={tab.id}
        data-tab-kind={tab.kind}
        data-dirty={dirty ? "true" : undefined}
        data-pinned={pinned ? "true" : undefined}
      >
        {renaming ? (
          <InlineRename
            value={tab.title}
            ariaLabel={`Rename ${tab.title}`}
            className="w-36"
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <button
            type="button"
            role="tab"
            aria-selected={active}
            aria-keyshortcuts="Shift+F10"
            onClick={onActivate}
            onDoubleClick={() => {
              if (tab.kind !== "editor") onStartRename();
            }}
            title={
              tab.kind === "editor"
                ? `${tab.filePath ?? tab.title}${dirty ? " · unsaved" : ""}`
                : `${tab.error ?? `${tab.cwd} · ${SESSION_STATUS_LABEL[tab.status]}`}`
            }
            className="flex items-center gap-2"
          >
            {tab.kind === "editor" ? (
              <span className="flex items-center gap-1" aria-hidden>
                <span className="rounded-xs border border-line px-1 font-mono text-[9px] uppercase text-ink-muted">
                  {languageBadge(languageIdForPath(tab.filePath ?? ""))}
                </span>
                {dirty ? <span className="size-1.5 rounded-full bg-warn" /> : null}
              </span>
            ) : tab.kind === "web" ? (
              <Globe className="size-3 shrink-0 text-ink-faint" aria-hidden />
            ) : (
              <span
                className={`size-1.5 rounded-full ${STATUS_DOT[tab.status]}`}
                aria-hidden
                data-status={tab.status}
              />
            )}
            <span className={`max-w-48 truncate ${dirty ? "italic" : ""}`}>{tab.title}</span>
            {pinned ? <Pin className="size-3 shrink-0 text-ink-faint" aria-hidden /> : null}
          </button>
        )}

        {pinned ? null : (
          <button
            type="button"
            aria-label={`Close ${tab.title}`}
            onClick={onClose}
            className="text-ink-faint hover:text-ink"
          >
            <X className="size-3" aria-hidden />
          </button>
        )}
      </div>
    </TabContextMenu>
  );
}
