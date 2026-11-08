/**
 * Settings → Notifications (2026-10-31 UI polish plan; classes 2026-11-08).
 *
 * Classes are the coarse switch (Info starts off so background chatter stays
 * out of the bell/transcript); per-message rules are the fine-grained one. Both
 * only hide a notification: the archive keeps every arrival, and the bell's
 * Show hidden row can recover it.
 */

import {
  NOTIFICATION_CLASSES,
  NOTIFICATION_CLASS_META,
  notificationRuleLabel,
} from "../../../shared/notifications";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

export function NotificationsSettingsCard() {
  const prefs = useAppStore((state) => state.prefs.notifications);
  const setNotificationClass = useAppStore((state) => state.setNotificationClass);
  const unmuteRule = useAppStore((state) => state.unmuteNotificationRule);
  const unmuteAll = useAppStore((state) => state.unmuteAllNotifications);

  return (
    <section className="card flex flex-col gap-3" data-testid="settings-notifications">
      <div>
        <h2 className="text-sm font-semibold">Notifications</h2>
        <p className="text-xs text-ink-muted">
          Classes decide which notifications appear in the bell, toasts and transcript. Rules
          silence one message (or one message shape). Hidden notifications stay in the history.
        </p>
      </div>

      <div className="flex flex-col gap-2" data-testid="notification-classes">
        <div>
          <h3 className="text-xs font-semibold">Classes</h3>
          <p className="text-xs text-ink-faint">
            Disabled classes are hidden from every surface. They stay in the history under Show
            hidden.
          </p>
        </div>
        <ul className="flex flex-col gap-1">
          {NOTIFICATION_CLASSES.map((klass) => {
            const meta = NOTIFICATION_CLASS_META[klass];
            return (
              <li
                key={klass}
                data-testid={`notification-class-${klass}`}
                className="flex items-start justify-between gap-3 rounded-sm border border-line bg-raised/40 px-2 py-1.5 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-medium text-ink">{meta.label}</div>
                  <div className="text-ink-faint">{meta.description}</div>
                </div>
                <Switch
                  checked={prefs.classes[klass]}
                  onCheckedChange={(enabled) => setNotificationClass(klass, enabled)}
                  aria-label={`Show ${meta.label.toLowerCase()}`}
                />
              </li>
            );
          })}
        </ul>
      </div>

      {prefs.muted.length === 0 ? (
        <p className="text-xs text-ink-faint" data-testid="notifications-empty">
          No muted notifications.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-ink-faint">
              {prefs.muted.length} muted rule{prefs.muted.length === 1 ? "" : "s"}
            </span>
            <Button size="sm" variant="ghost" onClick={unmuteAll}>
              Unmute all
            </Button>
          </div>
          <ul className="flex flex-col gap-1" data-testid="notification-mute-list">
            {prefs.muted.map((rule) => (
              <li
                key={rule.id}
                className="flex items-start gap-2 rounded-sm border border-line bg-raised/40 px-2 py-1.5 text-xs"
              >
                <Badge tone="neutral">{rule.scope}</Badge>
                <span className="min-w-0 flex-1 break-words">{notificationRuleLabel(rule)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Unmute ${notificationRuleLabel(rule)}`}
                  onClick={() => unmuteRule(rule.id)}
                >
                  Unmute
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
