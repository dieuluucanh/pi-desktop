/**
 * The per-tab lifecycle menu: the right-click context menu for the strips, the
 * “…” dropdown for the sidebar session list. The chip has no visible overflow
 * button, so `Shift+F10` / the Menu key opens the same menu through
 * `openTabContextMenuFromKeyboard`.
 *
 * The same item contract (`tabMenuItems`) and dispatcher feed both the “…”
 * dropdown and the right-click context menu, so the two surfaces cannot drift.
 */

import {
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  GitFork,
  ListTree,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Save,
  XCircle,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "../ui/cn";
import { useAppStore } from "../state/app-store";
import { useEditorStore } from "../editor/editor-store";
import { isEditorTab, type TabRecord } from "../../../shared/session-ipc";
import { workspaceAbsolutePath, workspaceDisplayRelativePath } from "../../../shared/workspace";
import { copyText } from "../ui/clipboard";
import { tabMenuItems, type TabMenuActionId } from "./tab-menu";
import { closeAllTabsAction, closeOtherTabsAction, setTabPinnedAction } from "./tab-actions";

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
    case "save":
      return <Save className="size-3.5" aria-hidden />;
    case "copy-absolute-path":
    case "copy-relative-path":
      return <Copy className="size-3.5" aria-hidden />;
    case "pin":
      return <Pin className="size-3.5" aria-hidden />;
    case "unpin":
      return <PinOff className="size-3.5" aria-hidden />;
    case "close-all":
      return <XCircle className="size-3.5" aria-hidden />;
    case "reload":
      return <RefreshCw className="size-3.5" aria-hidden />;
    case "copy-url":
    case "open-browser":
      return <ExternalLink className="size-3.5" aria-hidden />;
    default:
      return null;
  }
}

async function copyAndReport(value: string, label: string): Promise<void> {
  const copied = await copyText(value);
  useAppStore.getState().setHint(copied ? `${label} copied.` : "Could not copy the path.");
}

function runTabMenuAction(id: TabMenuActionId, tab: TabRecord, onRename: () => void): void {
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
      if (isEditorTab(tab) && tab.filePath) {
        void window.pi?.workspace.reveal({ projectPath: tab.cwd, path: tab.filePath });
      } else {
        void store.revealSessionFile(tab.id);
      }
      return;
    case "save":
      void useEditorStore.getState().save(tab.id);
      return;
    case "copy-absolute-path":
      if (isEditorTab(tab) && tab.filePath) {
        void copyAndReport(workspaceAbsolutePath(tab.cwd, tab.filePath), "Path");
      }
      return;
    case "copy-relative-path":
      if (isEditorTab(tab) && tab.filePath) {
        void copyAndReport(workspaceDisplayRelativePath(tab.cwd, tab.filePath), "Relative path");
      }
      return;
    case "pin":
      void setTabPinnedAction(tab.id, true);
      return;
    case "unpin":
      void setTabPinnedAction(tab.id, false);
      return;
    case "reload":
      store.webCommand(tab.id, { command: "reload" });
      return;
    case "copy-url":
      if (tab.url) void copyAndReport(tab.url, "URL");
      return;
    case "open-browser":
      if (tab.url) void window.pi?.openExternal(tab.url);
      return;
    case "close":
      if (isEditorTab(tab)) useEditorStore.getState().requestClose(tab.id);
      else void store.closeTab(tab.id);
      return;
    case "close-others":
      void closeOtherTabsAction(tab.id);
      return;
    case "close-all":
      void closeAllTabsAction(tab.kind);
      return;
  }
}

export interface TabMenuProps {
  tab: TabRecord;
  onRename: () => void;
  /** Where the menu opens relative to the trigger. */
  align?: "start" | "end";
  /** The trigger's accessible name; defaults to `Actions for <title>`. */
  triggerLabel?: string;
  /** Extra trigger classes (the sidebar hides it until row hover/focus). */
  triggerClassName?: string;
}

export function TabMenu({
  tab,
  onRename,
  align = "start",
  triggerLabel,
  triggerClassName,
}: TabMenuProps): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={triggerLabel ?? `Actions for ${tab.title}`}
          className={cn("text-ink-faint hover:text-ink", triggerClassName)}
        >
          <MoreHorizontal className="size-3" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        <DropdownMenuLabel>{tab.title}</DropdownMenuLabel>
        {tabMenuItems(tab.kind, tab.pinned === true).map((item) => (
          <span key={item.id}>
            {item.separated ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              {...(item.destructive ? { destructive: true } : {})}
              onSelect={() => runTabMenuAction(item.id, tab, onRename)}
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

/** The right-click menu. It renders the same items as `TabMenu`. */
export function TabContextMenu({
  tab,
  onRename,
  children,
}: {
  tab: TabRecord;
  onRename: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid="tab-context-menu">
        <ContextMenuLabel>{tab.title}</ContextMenuLabel>
        {tabMenuItems(tab.kind, tab.pinned === true).map((item) => (
          <span key={item.id}>
            {item.separated ? <ContextMenuSeparator /> : null}
            <ContextMenuItem
              {...(item.destructive ? { destructive: true } : {})}
              onSelect={() => runTabMenuAction(item.id, tab, onRename)}
            >
              <TabMenuIcon id={item.id} />
              {item.label}
            </ContextMenuItem>
          </span>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
