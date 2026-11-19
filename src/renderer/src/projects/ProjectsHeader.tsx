import { useState } from "react";
import { FolderClock, FolderOpen, FolderPlus, GitBranch, PanelLeftClose, Plus } from "lucide-react";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useAppStore } from "../state/app-store";
import { openProjectAction } from "../menu-actions";
import { CloneProjectDialog, CreateProjectDialog } from "./ProjectDialogs";

/**
 * The sidebar's Projects header: the label row above the project list, with the
 * `+` project menu, the open-folder action and the sidebar collapse button.
 *
 * `layout/Sidebar.tsx` renders it **outside** the sidebar's scroll container, so
 * it stays visible while the project list and the Views section scroll. Keep it
 * that way: a header rendered inside `ProjectsSection` is scroll content and
 * disappears the moment the list is taller than the window — that is the bug
 * this component exists to prevent, and the structural test in
 * `tests/renderer/sidebar.test.tsx` pins it.
 *
 * The pin is structural rather than `position: sticky`, mirroring the panel rail
 * (`rail/RightRail.tsx`, whose header is likewise a sibling of its scroller):
 * no opaque repaint, no `z-index` and no sticky offset to keep in sync with the
 * row it covers.
 *
 * The header owns the Create/Clone dialogs because it owns the menu that opens
 * them. Both are portaled to `document.body`, so being outside the scroll
 * viewport cannot clip them.
 */
export function ProjectsHeader() {
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const [createOpen, setCreateOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [defaultBusy, setDefaultBusy] = useState(false);

  // One click, no dialog: create the dated folder in Documents/Pi-Desktop,
  // make it active and open a session, exactly like the two dialogs do.
  const createDefault = async (): Promise<void> => {
    setDefaultBusy(true);
    try {
      if (await useAppStore.getState().createDefaultProject()) {
        await useAppStore.getState().createSessionTab();
      }
    } finally {
      setDefaultBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between px-2" data-testid="projects-header">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Projects
        </span>
        <div className="flex items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="New project" title="New project…">
                <Plus className="size-3.5" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={defaultBusy} onSelect={() => void createDefault()}>
                <FolderClock className="size-3.5" aria-hidden />
                New default project
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
                <FolderPlus className="size-3.5" aria-hidden />
                New project…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setCloneOpen(true)}>
                <GitBranch className="size-3.5" aria-hidden />
                Clone repository…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Open project folder"
            title="Open project folder…"
            onClick={() => void openProjectAction()}
          >
            <FolderOpen className="size-3.5" aria-hidden />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Hide sidebar"
            title="Hide sidebar (Ctrl+B)"
            onClick={toggleSidebar}
          >
            <PanelLeftClose className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
      <CloneProjectDialog open={cloneOpen} onOpenChange={setCloneOpen} />
    </>
  );
}
