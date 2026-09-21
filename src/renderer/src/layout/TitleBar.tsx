import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { newSessionAction, openProjectAction } from "../menu-actions";
import { useAppStore } from "../state/app-store";
import { UpdateBanner } from "../updates/UpdateBanner";

/** Top chrome: brand, active project, runtime facts that matter at a glance. */
export function TitleBar() {
  const info = useAppStore((state) => state.info);
  const project = useAppStore((state) => state.project);

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span
          className="size-2 rounded-full bg-ok"
          aria-hidden
          title={info?.isDev ? "development build" : "packaged build"}
        />
        Pi Desktop
        {info ? <span className="text-xs font-normal text-ink-faint">v{info.version}</span> : null}
      </div>

      {project ? (
        <div className="flex min-w-0 items-center gap-2 text-xs text-ink-muted">
          <span className="truncate" title={project.path}>
            {project.name}
          </span>
          <Badge tone="neutral">{project.path}</Badge>
        </div>
      ) : (
        <span className="text-xs text-ink-muted">No project open</span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <UpdateBanner />
        {info?.safeMode ? <Badge tone="warn">safe mode</Badge> : null}
        <Button size="sm" variant="ghost" onClick={() => void openProjectAction()}>
          Open project…
        </Button>
        <Button size="sm" variant="primary" onClick={newSessionAction}>
          New session
        </Button>
      </div>
    </header>
  );
}
