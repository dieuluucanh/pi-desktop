import { Badge } from "../ui/badge";
import { useAppStore } from "../state/app-store";
import { NotificationCenter } from "../extension-ui/NotificationCenter";

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
 *  - **The view mode** (`view: normal`) was machine vocabulary; it is a session
 *    transcript concern, not an app fact.
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
  const hint = useAppStore((state) => state.hint);

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
      <div className="ml-auto flex items-center gap-3">
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
