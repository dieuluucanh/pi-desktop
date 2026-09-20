import { useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useAppStore } from "../state/app-store";

/**
 * The notification centre (plan step 16).
 *
 * `ctx.ui.notify()` fires a toast (via sonner) and appends to a bounded history;
 * this is the history panel, reachable from the status bar. Toasts alone vanish,
 * so an extension error a user missed would otherwise be unrecoverable.
 */
export function NotificationCenter() {
  const notifications = useAppStore((state) => state.extensionNotifications);
  const clear = useAppStore((state) => state.clearExtensionNotifications);
  const [open, setOpen] = useState(false);

  if (notifications.length === 0) return null;
  const errors = notifications.filter((entry) => entry.type === "error").length;

  return (
    <div className="relative">
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        aria-label="Extension notifications"
        onClick={() => setOpen((value) => !value)}
      >
        notifications <Badge tone={errors > 0 ? "danger" : "neutral"}>{notifications.length}</Badge>
      </Button>
      {open ? (
        <div
          data-testid="extension-notifications"
          className="absolute bottom-8 right-0 z-50 w-80 rounded-md border border-line bg-surface p-2 shadow-xl"
        >
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-xs font-semibold">Extension notifications</span>
            <Button size="sm" variant="ghost" onClick={clear}>
              Clear
            </Button>
          </div>
          <ul className="max-h-64 overflow-y-auto">
            {notifications.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start gap-2 border-t border-line px-1 py-1 text-xs first:border-t-0"
              >
                <Badge
                  tone={
                    entry.type === "error"
                      ? "danger"
                      : entry.type === "warning"
                        ? "warn"
                        : "neutral"
                  }
                >
                  {entry.type}
                </Badge>
                <span className="min-w-0 flex-1 break-words">{entry.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
