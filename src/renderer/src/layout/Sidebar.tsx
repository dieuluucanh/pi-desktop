import {
  Activity,
  Blocks,
  FileSpreadsheet,
  FolderOpen,
  MessageSquarePlus,
  Plug,
  Settings as SettingsIcon,
  Sparkles,
} from "lucide-react";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { newSessionAction, openProjectAction } from "../menu-actions";
import { useAppStore, type AppView } from "../state/app-store";

/**
 * The sidebar (plan step 1, IA per D-A4): projects → sessions on top, the
 * product views below. Projects themselves become real in step 10; today the
 * section explains what will live there instead of pretending to have data.
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
  const project = useAppStore((state) => state.project);
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
          <SectionLabel>Project</SectionLabel>
          {project ? (
            <div className="rounded-sm border border-line bg-raised px-2 py-1.5">
              <div className="truncate text-sm">{project.name}</div>
              <div className="truncate text-[11px] text-ink-faint" title={project.path}>
                {project.path}
              </div>
            </div>
          ) : (
            <p className="px-2 py-1 text-xs text-ink-muted">
              No project open. Sessions are grouped by project, the way terminal Pi scopes them to a
              folder.
            </p>
          )}

          <SectionLabel>Sessions</SectionLabel>
          <p className="px-2 py-1 text-xs text-ink-muted">
            Session tabs appear here once the session service lands (step 3).
          </p>

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

          <SectionLabel>Integrations</SectionLabel>
          <Button
            variant={view === "office" ? "secondary" : "ghost"}
            className="justify-start"
            onClick={() => setView("office")}
            aria-current={view === "office"}
          >
            <FileSpreadsheet className="size-4" aria-hidden />
            <span className="flex-1 text-left">Pi for Office</span>
          </Button>
          <p className="px-2 py-1 text-xs text-ink-muted">
            Optional. Installs the Office bridge as a normal Pi extension; the app works without it.
          </p>
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
