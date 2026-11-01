/**
 * Settings → Notifications (2026-10-31 UI polish plan).
 *
 * The gear on a toast is the quick path; this card is the durable one. It lists
 * every persisted mute rule (exact text, template signature or whole type) and
 * offers Unmute / Unmute all. Muted notifications are still archived in the
 * notification centre, so nothing is lost by silencing a noisy advisory.
 */

import { notificationRuleLabel } from "../../../shared/notifications";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export function NotificationsSettingsCard() {
  const prefs = useAppStore((state) => state.prefs.notifications);
  const unmuteRule = useAppStore((state) => state.unmuteNotificationRule);
  const unmuteAll = useAppStore((state) => state.unmuteAllNotifications);

  return (
    <section className="card flex flex-col gap-3" data-testid="settings-notifications">
      <div>
        <h2 className="text-sm font-semibold">Notifications</h2>
        <p className="text-xs text-ink-muted">
          Muted extension notifications stop appearing in the transcript and stop toasting, but stay
          in the notification history. Unmute them here.
        </p>
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
