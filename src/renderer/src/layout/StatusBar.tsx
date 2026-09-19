import { Badge } from "../ui/badge";
import { useAppStore } from "../state/app-store";

/** Bottom status bar: runtime, profile and view-mode facts. */
export function StatusBar() {
  const info = useAppStore((state) => state.info);
  const hint = useAppStore((state) => state.hint);
  const viewMode = useAppStore((state) => state.prefs.viewMode);

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 text-[11px] text-ink-muted">
      <span title="The profile shared with terminal Pi">
        profile: {info?.profileDir ?? "unavailable"}
      </span>
      <span title="Bundled Node runtime used by Pi hosts">
        runtime: {info?.runtimeSource ?? "unavailable"}
        {info?.runtimeNodeVersion ? ` · node ${info.runtimeNodeVersion}` : ""}
      </span>
      <span className="ml-auto">view: {viewMode}</span>
      {hint ? <Badge tone="accent">{hint}</Badge> : null}
    </footer>
  );
}
