import { useAppStore } from "../state/app-store";
import {
  extensionWidgetsByPlacement,
  type ExtensionWidgetPlacement,
} from "../../../shared/extension-ui";

/**
 * Extension widgets (plan step 16).
 *
 * `ctx.ui.setWidget(key, string[])` renders a small text strip above or below the
 * composer. Component-factory widgets are a TUI-surface concern (step 17) and are
 * deliberately not rendered here.
 */
export function WidgetStrip({
  tabId,
  placement,
}: {
  tabId: string;
  placement: ExtensionWidgetPlacement;
}) {
  const snapshot = useAppStore((state) => state.extensionUi[tabId]);
  if (!snapshot) return null;
  const widgets = extensionWidgetsByPlacement(snapshot, placement);
  if (widgets.length === 0) return null;

  return (
    <div
      data-testid={`extension-widgets-${placement}`}
      className="flex shrink-0 flex-col gap-0.5 border-t border-line bg-sunken px-3 py-1 font-mono text-[11px] text-ink-muted"
    >
      {widgets.map((widget) => (
        <pre key={widget.key} className="whitespace-pre-wrap">
          {widget.lines.join("\n")}
        </pre>
      ))}
    </div>
  );
}
