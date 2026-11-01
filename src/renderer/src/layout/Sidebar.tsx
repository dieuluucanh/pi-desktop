import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Activity, Blocks, Plug, Settings as SettingsIcon, Sparkles } from "lucide-react";
import { clampSidebarWidth } from "../../../shared/prefs";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { ProjectsSection } from "../projects/ProjectsSection";
import { useAppStore, type AppView } from "../state/app-store";
import { setSidebarWidth } from "../state/sidebar-width";

/**
 * The sidebar (plan step 1, IA per D-A4): projects → sessions on top, the
 * product views below. Projects became real in step 10, so the section is now
 * the workspace list with each project's session list beneath it.
 *
 * The old New session / Open project… buttons were removed in the
 * minimal-session-ui plan: the tab strip owns New session, and the Projects
 * header owns both the + project menu and the open-folder icon.
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
  // Mirrors RightRail's width drag: local state follows the pointer; one
  // preference write on release. The ref survives the pointerup batch.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragWidthRef = useRef<number | null>(null);
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  const shownWidth = dragWidth ?? width;
  const trackDrag = (next: number | null): void => {
    dragWidthRef.current = next;
    setDragWidth(next);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    dragStart.current = { x: event.clientX, width: shownWidth };
    trackDrag(shownWidth);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = dragStart.current;
    if (!start) return;
    trackDrag(clampSidebarWidth(start.width + (event.clientX - start.x)));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragStart.current) return;
    dragStart.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const next = dragWidthRef.current ?? width;
    trackDrag(null);
    if (next !== width) setSidebarWidth(next);
  };

  if (collapsed) return null;

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r border-line bg-surface"
      style={{ width: shownWidth }}
      aria-label="Navigation"
      data-testid="sidebar"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={shownWidth}
        tabIndex={0}
        className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize hover:bg-accent/40 focus:bg-accent/40 focus:outline-none"
        data-testid="sidebar-resize"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            setSidebarWidth(clampSidebarWidth(shownWidth + 20));
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            setSidebarWidth(clampSidebarWidth(shownWidth - 20));
          }
        }}
      />
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
