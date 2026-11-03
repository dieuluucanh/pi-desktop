import {
  ClipboardPaste,
  Copy,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Scissors,
  Trash2,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { useFileClipboardStore } from "../files/file-clipboard-store";
import {
  explorerMenuItems,
  type ExplorerMenuActionId,
  type ExplorerMenuTarget,
} from "./explorer-menu";

function ExplorerMenuIcon({ id }: { id: ExplorerMenuActionId }) {
  switch (id) {
    case "open":
      return <FolderOpen className="size-3.5" aria-hidden />;
    case "new-file":
      return <FilePlus2 className="size-3.5" aria-hidden />;
    case "new-folder":
      return <FolderPlus className="size-3.5" aria-hidden />;
    case "add-to-chat":
      return <MessageSquarePlus className="size-3.5" aria-hidden />;
    case "copy":
      return <Copy className="size-3.5" aria-hidden />;
    case "cut":
      return <Scissors className="size-3.5" aria-hidden />;
    case "paste":
      return <ClipboardPaste className="size-3.5" aria-hidden />;
    case "rename":
      return <Pencil className="size-3.5" aria-hidden />;
    case "delete":
      return <Trash2 className="size-3.5" aria-hidden />;
    case "reveal":
      return <FolderOpen className="size-3.5" aria-hidden />;
    case "copy-path":
    case "copy-relative-path":
      return <Copy className="size-3.5" aria-hidden />;
    case "refresh":
      return <RefreshCw className="size-3.5" aria-hidden />;
  }
}

export interface ExplorerContextMenuProps {
  target: ExplorerMenuTarget | null;
  onAction: (id: ExplorerMenuActionId, target: ExplorerMenuTarget | null) => void;
  children: React.ReactNode;
}

/** The shared explorer menu: rows, search results and the tree's blank area. */
export function ExplorerContextMenu({
  target,
  onAction,
  children,
}: ExplorerContextMenuProps): React.JSX.Element {
  const clipboard = useFileClipboardStore((state) => state.clipboard);
  const items = explorerMenuItems(target, {
    clipboard: clipboard ? { mode: clipboard.mode } : null,
  });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid="explorer-menu">
        <ContextMenuLabel>{target?.name ?? "Project"}</ContextMenuLabel>
        {items.map((item) => (
          <span key={item.id}>
            {item.separated ? <ContextMenuSeparator /> : null}
            <ContextMenuItem
              {...(item.destructive ? { destructive: true } : {})}
              {...(item.disabled ? { disabled: true } : {})}
              onSelect={() => onAction(item.id, target)}
            >
              <ExplorerMenuIcon id={item.id} />
              {item.label}
            </ContextMenuItem>
          </span>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
