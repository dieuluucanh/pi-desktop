/**
 * The per-tab lifecycle menu, shared by the tab strip and the sidebar session
 * list (2026-10-31 UI plan).
 *
 * The contract (`TabMenuActionId` / `tabMenuItems`) stays in `tab-menu.ts`;
 * this module owns the Radix trigger and the dispatch switch. `triggerLabel`
 * lets the sidebar distinguish its "Session actions for …" control from the tab
 * strip's "Actions for …" control for assistive tech and tests.
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
  RefreshCw,
} from "lucide-react";

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
import { copyToClipboard } from "../web/clipboard";
import type { TabRecord } from "../../../shared/session-ipc";
import { tabMenuItems, type TabMenuActionId } from "./tab-menu";

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
    case "reload":
      return <RefreshCw className="size-3.5" aria-hidden />;
    case "copy-url":
    case "open-browser":
      return <ExternalLink className="size-3.5" aria-hidden />;
    default:
      return null;
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
          aria-label={triggerLabel ?? `Actions for ${tab.title}`}
          className={cn("text-ink-faint hover:text-ink", triggerClassName)}
        >
          <MoreHorizontal className="size-3" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
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
