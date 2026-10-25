import { useState } from "react";
import {
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  GitFork,
  Globe,
  ListTree,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { tabMenuItems, type TabMenuActionId } from "./tab-menu";
import { copyToClipboard } from "../web/clipboard";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { newSessionAction } from "../menu-actions";
import { useAppStore } from "../state/app-store";
import { SESSION_STATUS_LABEL, type TabRecord, type TabStatus } from "../../../shared/session-ipc";

/**
 * Session tab strip (plan step 1 shell, real tabs since step 3, full lifecycle
 * since step 11).
 *
 * A tab is the renderer's handle on a supervised Pi host: clicking it activates
 * (and, if needed, re-spawns) the host, the `X` closes the tab and stops it, and
 * the dot shows the host's lifecycle at a glance. The per-tab menu carries the
 * rest of a session's lifecycle — rename, duplicate, clone, fork, export,
 * reveal, close others — and tabs can be dragged to reorder the strip (the
 * session service persists the order).
 */

const STATUS_DOT: Record<TabStatus, string> = {
  starting: "bg-warn",
  idle: "bg-ok",
  running: "bg-accent",
  crashed: "bg-danger",
  failed: "bg-danger",
  stopped: "bg-ink-faint",
};

export function TabStrip() {
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const activateTab = useAppStore((state) => state.activateTab);
  const closeTab = useAppStore((state) => state.closeTab);
  const project = useAppStore((state) => state.project);
  const [dragId, setDragId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<TabRecord | null>(null);

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-sunken px-1"
      role="tablist"
      aria-label="Session tabs"
    >
      {tabs.map((tab, index) => {
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            draggable
            onDragStart={() => setDragId(tab.id)}
            onDragEnd={() => setDragId(null)}
            onDragOver={(event) => {
              if (dragId && dragId !== tab.id) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragId && dragId !== tab.id) {
                void useAppStore.getState().moveTab(dragId, index);
              }
              setDragId(null);
            }}
            className={`flex h-7 items-center gap-1 rounded-sm border px-2 text-xs ${
              active ? "border-line-strong bg-surface" : "border-transparent bg-transparent"
            } ${dragId === tab.id ? "opacity-60" : ""}`}
            data-testid={`tab-${tab.id}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => void activateTab(tab.id)}
              title={tab.error ?? `${tab.cwd} · ${SESSION_STATUS_LABEL[tab.status]}`}
              className="flex items-center gap-2"
            >
              {tab.kind === "web" ? (
                <Globe className="size-3 shrink-0 text-ink-faint" aria-hidden />
              ) : (
                <span
                  className={`size-1.5 rounded-full ${STATUS_DOT[tab.status]}`}
                  aria-hidden
                  data-status={tab.status}
                />
              )}
              <span className="max-w-48 truncate">{tab.title}</span>
            </button>

            <TabMenu tab={tab} onRename={() => setRenaming(tab)} />

            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              onClick={() => void closeTab(tab.id)}
              className="text-ink-faint hover:text-ink"
            >
              <X className="size-3" aria-hidden />
            </button>
          </div>
        );
      })}

      {tabs.length === 0 ? (
        <span className="px-2 text-[11px] text-ink-faint">
          {project ? "No session open" : "No project open"}
        </span>
      ) : null}

      <Button
        size="icon-sm"
        variant="ghost"
        className="ml-auto"
        onClick={newSessionAction}
        aria-label="New session"
        title="New session (Ctrl+N)"
      >
        <Plus className="size-3.5" aria-hidden />
      </Button>

      <RenameTabDialog tab={renaming} onClose={() => setRenaming(null)} />
    </div>
  );
}

function TabMenuIcon({ id }: { id: TabMenuActionId }) {
  switch (id) {
    case "rename":
      return <Pencil className="size-3.5" aria-hidden />;
    case "duplicate":
    case "clone":
      return <Copy className="size-3.5" aria-hidden />;
    case "tree":
      return <ListTree className="size-3.5" aria-hidden />;
    case "fork":
      return <GitFork className="size-3.5" aria-hidden />;
    case "export":
      return <Download className="size-3.5" aria-hidden />;
    case "reveal":
      return <FolderOpen className="size-3.5" aria-hidden />;
    // Web tabs (plan step 21).
    case "reload":
      return <RefreshCw className="size-3.5" aria-hidden />;
    case "copy-url":
    case "open-browser":
      return <ExternalLink className="size-3.5" aria-hidden />;
    default:
      return null;
  }
}

/** The per-tab lifecycle menu. */
function TabMenu({ tab, onRename }: { tab: TabRecord; onRename: () => void }) {
  const run = (id: TabMenuActionId): void => {
    const store = useAppStore.getState();
    switch (id) {
      case "rename":
        onRename();
        return;
      case "duplicate":
        void store.duplicateTab(tab.id);
        return;
      case "tree":
        void store.openSessionTree(tab.id);
        return;
      case "fork":
        void store.openFork(tab.id);
        return;
      case "clone":
        void store.cloneSession(tab.id);
        return;
      case "export":
        void store.exportSessionHtml(tab.id);
        return;
      case "reveal":
        void store.revealSessionFile(tab.id);
        return;
      // Web tabs (plan step 21): the chrome commands, not session lifecycle.
      case "reload":
        store.webCommand(tab.id, { command: "reload" });
        return;
      case "copy-url":
        if (tab.url) {
          copyToClipboard(tab.url);
          store.setHint("URL copied.");
        }
        return;
      case "open-browser":
        if (tab.url) void window.pi?.openExternal(tab.url);
        return;
      case "close":
        void store.closeTab(tab.id);
        return;
      case "close-others":
        void store.closeOtherTabs(tab.id);
        return;
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${tab.title}`}
          className="text-ink-faint hover:text-ink"
        >
          <MoreHorizontal className="size-3" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{tab.title}</DropdownMenuLabel>
        {tabMenuItems(tab.kind).map((item) => (
          <span key={item.id}>
            {item.separated ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              {...(item.destructive ? { destructive: true } : {})}
              onSelect={() => run(item.id)}
            >
              <TabMenuIcon id={item.id} />
              {item.label}
            </DropdownMenuItem>
          </span>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Inline rename, sharing the store action the session header uses. */
function RenameTabDialog({ tab, onClose }: { tab: TabRecord | null; onClose: () => void }) {
  const renameSession = useAppStore((state) => state.renameSession);
  const [value, setValue] = useState("");

  if (!tab) return null;
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent aria-describedby={undefined} className="w-[min(420px,92vw)]">
        <DialogTitle>Rename session</DialogTitle>
        <DialogDescription>Shown in the tab strip and in Pi's session list.</DialogDescription>
        <form
          className="flex flex-col gap-3 px-4 pb-4"
          onSubmit={(event) => {
            event.preventDefault();
            void renameSession(tab.id, value);
            onClose();
          }}
        >
          <input
            aria-label="Session name"
            autoFocus
            defaultValue={tab.title}
            onChange={(event) => setValue(event.target.value)}
            className="rounded-sm border border-line bg-raised px-2 py-1.5 text-sm text-ink outline-none"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Rename
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
