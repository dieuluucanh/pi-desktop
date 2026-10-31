import { Minus, Plus } from "lucide-react";
import { Badge } from "../ui/badge";
import { useAppStore } from "../state/app-store";
import { NotificationCenter } from "../extension-ui/NotificationCenter";
import { formatZoomPercent } from "../../../shared/zoom";
import { compactPath, tildePath } from "../../../shared/paths";

/**
 * The app-level status bar (2026-10-19 UI rework).
 *
 * It is deliberately small and does **one** job: app facts that are not
 * session-specific — the build, the Pi profile and the bundled runtime — plus
 * the transient hint and the notification centre. It stays mounted on every
 * view, including Welcome, Settings and Extensions, where a session footer has
 * nothing to say.
 *
 * What used to be here and is now elsewhere:
 *
 *  - **Extension statuses** (`ctx.ui.setStatus`, e.g. the Office bridge's
 *    `office: Excel attached (bridge :38617)`) render in the composer footer,
 *    next to the session they describe.
 *  - **The view mode** was removed (2026-10-30 copy plan); Ctrl+O is the one
 *    tool-detail switch. Display zoom lives here because it is an app fact.
 *
 * The active project folder is the first app fact in the bar (minimal-session-ui
 * step 3): the removed title bar was its only home. The session-scoped cwd still
 * lives in the session footer, so the two never compete for the same line.
 *
 * Every value that can be long keeps its full form in a `title`, so the visible
 * chrome stays one line while nothing becomes unreachable. The profile path is
 * also exposed as `data-profile` because the packaged E2E test proves
 * `PI_CODING_AGENT_DIR` reached the app through it.
 */

/** Last path segment, for a compact chip label (the full value stays in `title`). */
export function lastPathSegment(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : path;
}

export function StatusBar() {
  const info = useAppStore((state) => state.info);
  const project = useAppStore((state) => state.project);
  const hint = useAppStore((state) => state.hint);
  const zoomFactor = useAppStore((state) => state.prefs.zoomFactor);
  const zoomIn = useAppStore((state) => state.zoomIn);
  const zoomOut = useAppStore((state) => state.zoomOut);
  const zoomReset = useAppStore((state) => state.zoomReset);
  const zoomLabel = formatZoomPercent(zoomFactor);

  const runtimeProblems = info?.runtimeProblems ?? [];
  const runtimeTitle = [
    `Bundled Node runtime used by Pi hosts: ${info?.runtimeSource ?? "unavailable"}`,
    info?.runtimeNodeVersion ? `node ${info.runtimeNodeVersion}` : null,
    runtimeProblems.length > 0 ? `${runtimeProblems.length} problem(s)` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 text-[11px] text-ink-muted">
      <span
        data-testid="status-project"
        className="min-w-0 truncate"
        title={project ? project.path : "No project open"}
      >
        {project ? compactPath(tildePath(project.path, info?.homeDir)) : "No project open"}
      </span>
      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center gap-0.5" data-testid="status-zoom">
          <button
            type="button"
            className="rounded-xs p-0.5 hover:bg-raised hover:text-ink"
            aria-label="Zoom out"
            title="Zoom out (Ctrl/Cmd -)"
            onClick={zoomOut}
          >
            <Minus className="size-3" aria-hidden />
          </button>
          <button
            type="button"
            className="min-w-9 rounded-xs px-1 tabular-nums hover:bg-raised hover:text-ink"
            aria-label="Reset zoom"
            title={`Display zoom: ${zoomLabel} — reset to 100% (Ctrl/Cmd 0)`}
            onClick={zoomReset}
          >
            {zoomLabel}
          </button>
          <button
            type="button"
            className="rounded-xs p-0.5 hover:bg-raised hover:text-ink"
            aria-label="Zoom in"
            title="Zoom in (Ctrl/Cmd =)"
            onClick={zoomIn}
          >
            <Plus className="size-3" aria-hidden />
          </button>
        </div>
        {info ? (
          <span data-testid="status-version" title={`Pi Desktop ${info.version}`}>
            v{info.version}
          </span>
        ) : null}
        <span
          data-testid="status-profile"
          data-profile={info?.profileDir ?? ""}
          title={
            info
              ? `The profile shared with terminal Pi: ${info.profileDir}`
              : "The Pi profile is unavailable."
          }
        >
          profile: {info ? lastPathSegment(info.profileDir) : "unavailable"}
        </span>
        <span
          data-testid="status-runtime"
          title={runtimeTitle}
          className={runtimeProblems.length > 0 ? "text-warn" : undefined}
        >
          runtime: {info?.runtimeSource ?? "unavailable"}
          {info?.runtimeNodeVersion ? ` · node ${info.runtimeNodeVersion}` : ""}
        </span>
        {hint ? <Badge tone="accent">{hint}</Badge> : null}
        <NotificationCenter />
      </div>
    </footer>
  );
}
