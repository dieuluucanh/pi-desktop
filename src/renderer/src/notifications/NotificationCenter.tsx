import { useState } from "react";
import { Bell, Settings2, X } from "lucide-react";

import {
  isNotificationClassEnabled,
  isNotificationSuppressed,
  matchingMuteRule,
  notificationClassOf,
  type AppNotification,
  type NotificationClass,
} from "../../../shared/notifications";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";

/**
 * The notification centre (plan step 16; rebuilt 2026-11-08).
 *
 * `ctx.ui.notify()` and the app's own update offer share one bounded archive.
 * The bell is the only entry point: its count covers unsuppressed rows, and the
 * popover groups each row by class so the Settings class switches explain what
 * is hidden. A class-disabled or rule-matched notification stays in the archive
 * (`Show hidden`) so a user can recover it instead of losing it to a mute.
 */

const CLASS_TONE: Record<NotificationClass, "neutral" | "accent" | "info" | "warn" | "danger"> = {
  update: "accent",
  error: "danger",
  warning: "warn",
  info: "neutral",
};

export function NotificationCenter() {
  const notifications = useAppStore((state) => state.notifications);
  const prefs = useAppStore((state) => state.prefs.notifications);
  const clear = useAppStore((state) => state.clearNotifications);
  const dismiss = useAppStore((state) => state.dismissNotification);
  const openMuteDialog = useAppStore((state) => state.openMuteDialog);
  const unmuteNotification = useAppStore((state) => state.unmuteNotification);
  const setNotificationClass = useAppStore((state) => state.setNotificationClass);
  const openNotificationSettings = useAppStore((state) => state.openNotificationSettings);
  const openUpdatesView = useAppStore((state) => state.openUpdatesView);
  const [open, setOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  const visible = notifications.filter((entry) => !isNotificationSuppressed(entry, prefs));
  const hidden = notifications.filter((entry) => isNotificationSuppressed(entry, prefs));
  const count = visible.length;
  const errors = visible.filter((entry) => entry.class === "error").length;
  const list = showHidden ? notifications : visible;

  const close = (): void => {
    setOpen(false);
    setShowHidden(false);
  };
  const toggle = (): void => {
    if (open) close();
    else setOpen(true);
  };
  const run = (entry: AppNotification): void => {
    if (entry.action?.kind === "open-updates") {
      close();
      openUpdatesView();
    }
  };

  return (
    <div className="relative">
      <Button
        size="icon-sm"
        variant="ghost"
        className="relative"
        aria-expanded={open}
        aria-label={`Notifications${count > 0 ? ` (${count})` : ""}`}
        title={count > 0 ? `${count} notification${count === 1 ? "" : "s"}` : "Notifications"}
        onClick={toggle}
      >
        <Bell className="size-3.5" aria-hidden />
        {count > 0 ? (
          <span
            data-testid="notification-count"
            aria-hidden
            className={cn(
              "absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none text-surface",
              errors > 0 ? "bg-danger" : "bg-accent",
            )}
          >
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </Button>
      {open ? (
        <div
          data-testid="notification-center"
          role="dialog"
          aria-label="Notifications"
          className="absolute bottom-8 right-0 z-50 w-96 rounded-md border border-line bg-surface p-2 shadow-xl"
        >
          <div className="mb-1 flex items-center justify-between gap-2 px-1">
            <span className="text-xs font-semibold">Notifications</span>
            <div className="flex items-center gap-1">
              {notifications.length > 0 ? (
                <Button size="sm" variant="ghost" onClick={clear}>
                  Clear
                </Button>
              ) : null}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Close notifications"
                title="Close notifications"
                onClick={close}
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            </div>
          </div>

          {notifications.length === 0 ? (
            <p className="px-1 py-3 text-xs text-ink-faint">No notifications.</p>
          ) : (
            <>
              <ul className="max-h-64 overflow-y-auto">
                {list.map((entry) => {
                  const klass = notificationClassOf(entry);
                  const classEnabled = isNotificationClassEnabled(prefs, klass);
                  const rule = matchingMuteRule(entry, prefs.muted);
                  return (
                    <li
                      key={entry.id}
                      className="flex items-start gap-2 border-t border-line px-1 py-1 text-xs first:border-t-0"
                    >
                      <Badge tone={CLASS_TONE[klass]}>{klass}</Badge>
                      {entry.action ? (
                        <button
                          type="button"
                          className="min-w-0 flex-1 break-words text-left hover:underline"
                          onClick={() => run(entry)}
                        >
                          {entry.message}
                        </button>
                      ) : (
                        <span className="min-w-0 flex-1 break-words">{entry.message}</span>
                      )}
                      {!classEnabled ? (
                        <Badge tone="neutral" data-testid="notification-hidden">
                          hidden
                        </Badge>
                      ) : rule ? (
                        <Badge tone="neutral" data-testid="notification-muted">
                          muted
                        </Badge>
                      ) : null}
                      {rule ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Unmute notification: ${entry.message}`}
                          onClick={() => unmuteNotification(entry)}
                        >
                          Unmute
                        </Button>
                      ) : null}
                      {!classEnabled ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Show ${klass} notifications`}
                          onClick={() => setNotificationClass(klass, true)}
                        >
                          Show
                        </Button>
                      ) : null}
                      {entry.action ? null : (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Notification settings for ${entry.message}`}
                          title="Notification settings"
                          onClick={() => openMuteDialog(entry)}
                        >
                          <Settings2 className="size-3.5" aria-hidden />
                        </Button>
                      )}
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Dismiss notification: ${entry.message}`}
                        title="Dismiss notification"
                        onClick={() => dismiss(entry.id)}
                      >
                        <X className="size-3" aria-hidden />
                      </Button>
                    </li>
                  );
                })}
              </ul>
              {!showHidden && visible.length === 0 && hidden.length > 0 ? (
                <p className="px-1 pt-1 text-xs text-ink-faint">You're all caught up.</p>
              ) : null}
              {hidden.length > 0 ? (
                <div className="mt-1 flex items-center gap-2 border-t border-line px-1 pt-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-pressed={showHidden}
                    onClick={() => setShowHidden((value) => !value)}
                  >
                    {showHidden ? "Hide hidden" : `Show hidden (${hidden.length})`}
                  </Button>
                </div>
              ) : null}
            </>
          )}

          <div className="mt-1 flex items-center justify-between border-t border-line px-1 pt-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                close();
                openNotificationSettings();
              }}
            >
              Notification settings
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
