import { Badge } from "../ui/badge";
import { useAppStore } from "../state/app-store";
import { NotificationCenter } from "../extension-ui/NotificationCenter";

/**
 * Bottom status bar: runtime, profile and view-mode facts, plus the extension
 * status entries (`ctx.ui.setStatus`) and the notification centre (plan step 16).
 */
export function StatusBar() {
  const info = useAppStore((state) => state.info);
  const hint = useAppStore((state) => state.hint);
  const viewMode = useAppStore((state) => state.prefs.viewMode);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const extensionUi = useAppStore((state) =>
    activeTabId ? state.extensionUi[activeTabId] : undefined,
  );
  const entries = Object.entries(extensionUi?.statuses ?? {});

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 text-[11px] text-ink-muted">
      <span title="The profile shared with terminal Pi">
        profile: {info?.profileDir ?? "unavailable"}
      </span>
      <span title="Bundled Node runtime used by Pi hosts">
        runtime: {info?.runtimeSource ?? "unavailable"}
        {info?.runtimeNodeVersion ? ` · node ${info.runtimeNodeVersion}` : ""}
      </span>
      {entries.map(([key, text]) => (
        <span key={key} title={`Extension status: ${key}`} data-testid={`extension-status-${key}`}>
          {text}
        </span>
      ))}
      <div className="ml-auto flex items-center gap-3">
        <span>view: {viewMode}</span>
        {hint ? <Badge tone="accent">{hint}</Badge> : null}
        <NotificationCenter />
      </div>
    </footer>
  );
}
