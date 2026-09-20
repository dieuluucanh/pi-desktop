import {
  Activity,
  Blocks,
  FolderOpen,
  MessageSquarePlus,
  Plug,
  Settings as SettingsIcon,
  Sparkles,
} from "lucide-react";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { ProjectsSection } from "../projects/ProjectsSection";
import { newSessionAction, openProjectAction } from "../menu-actions";
import { useAppStore, type AppView } from "../state/app-store";

/**
 * The sidebar (plan step 1, IA per D-A4): projects → sessions on top, the
 * product views below. Projects became real in step 10, so the section is now
 * the workspace list with each project's session list beneath it.
 */

interface NavItem {
  view: AppView;
  label: string;
  icon: typeof SettingsIcon;
  shortcut?: string;
}

const VIEW_ITEMS: readonly NavItem[] = [
  { view: "settings", label: "Settings", icon: SettingsIcon, shortcut: "Ctrl+," },
  { view: "extensions", label: "Extensions", icon: Blocks },
  { view: "connections", label: "Connections", icon: Plug },
  { view: "skills", label: "Skills & themes", icon: Sparkles },
  { view: "diagnostics", label: "Diagnostics", icon: Activity },
];

export function Sidebar() {
  const view = useAppStore((state) => state.view);
  const collapsed = useAppStore((state) => state.prefs.sidebarCollapsed);
  const width = useAppStore((state) => state.prefs.sidebarWidth);
  const setView = useAppStore((state) => state.setView);

  if (collapsed) return null;

  return (
    <aside
      className="flex shrink-0 flex-col border-r border-line bg-surface"
      style={{ width }}
      aria-label="Navigation"
    >
      <div className="flex flex-col gap-2 p-3">
        <Button variant="primary" onClick={newSessionAction}>
          <MessageSquarePlus className="size-4" aria-hidden />
          New session
        </Button>
        <Button variant="secondary" onClick={() => void openProjectAction()}>
          <FolderOpen className="size-4" aria-hidden />
          Open project…
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <nav className="flex flex-col gap-1 px-2 pb-4">
          <ProjectsSection />

          <SectionLabel>Views</SectionLabel>
          {VIEW_ITEMS.map((item) => (
            <Button
              key={item.view}
              variant={view === item.view ? "secondary" : "ghost"}
              className="justify-start"
              onClick={() => setView(item.view)}
              aria-current={view === item.view}
            >
              <item.icon className="size-4" aria-hidden />
              <span className="flex-1 text-left">{item.label}</span>
              {item.shortcut ? (
                <span className="text-[11px] text-ink-faint">{item.shortcut}</span>
              ) : null}
            </Button>
          ))}
        </nav>
      </ScrollArea>
    </aside>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 px-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
      {children}
    </div>
  );
}
