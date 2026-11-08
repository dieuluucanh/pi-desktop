/**
 * The notification settings dialog (2026-10-31 UI polish plan).
 *
 * Opened by the gear on a warning/error toast or by a notification-history row.
 * `oi.notify` has no extension/source field, so the three choices are derived
 * from the message: the exact text, a stable signature ("warnings like this"),
 * or every notification of the same type. The dialog shows the concrete rule it
 * will save, and muted entries remain in history with an Unmute path.
 */

import { useState } from "react";

import {
  matchingMuteRule,
  normalizeNotificationText,
  notificationRuleLabel,
  notificationSignature,
  type NotificationMuteScope,
} from "../../../shared/notifications";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { cn } from "../ui/cn";

const SCOPES: readonly NotificationMuteScope[] = ["exact", "template", "type"];

/** The preferred option: template when it differs from the exact text. */
function defaultScope(message: string): NotificationMuteScope {
  return notificationSignature(message) !== normalizeNotificationText(message)
    ? "template"
    : "exact";
}

function scopeLabel(scope: NotificationMuteScope, type: "info" | "warning" | "error"): string {
  if (scope === "exact") return "Just this notification";
  if (scope === "template") return `All ${type}s like this`;
  return `All ${type} notifications`;
}

export function MuteNotificationDialog() {
  const target = useAppStore((state) => state.muteTarget);
  const prefs = useAppStore((state) => state.prefs.notifications);
  const close = useAppStore((state) => state.closeMuteDialog);
  const mute = useAppStore((state) => state.muteNotification);
  const unmute = useAppStore((state) => state.unmuteNotification);
  // The choice is keyed to the notification id, so opening the dialog for a
  // different message starts at its default without a setState-in-effect.
  const [choice, setChoice] = useState<{ id: string; scope: NotificationMuteScope } | null>(null);
  const scope =
    choice && target && choice.id === target.id
      ? choice.scope
      : defaultScope(target?.message ?? "");
  const setScope = (value: NotificationMuteScope): void => {
    if (target) setChoice({ id: target.id, scope: value });
  };

  const exact = target ? normalizeNotificationText(target.message) : "";
  const signature = target ? notificationSignature(target.message) : "";
  const currentRule = target ? matchingMuteRule(target, prefs.muted) : null;

  if (!target) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        data-testid="mute-notification-dialog"
        className="w-[min(520px,92vw)]"
      >
        <DialogTitle>Notification settings</DialogTitle>
        <DialogDescription>
          Muted notifications disappear from the transcript and stop toasting, but stay in the
          notification history. Unmute them any time in Settings → Notifications.
        </DialogDescription>

        <div className="mx-4 rounded-sm border border-line bg-raised/60 px-3 py-2">
          <div className="mb-1 flex items-center gap-2">
            <Badge tone={target.type === "error" ? "danger" : "warn"}>{target.type}</Badge>
            {currentRule ? <Badge tone="neutral">muted</Badge> : null}
          </div>
          <p className="max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-ink-muted">
            {target.message}
          </p>
        </div>

        <fieldset className="mx-4 mt-3 flex flex-col gap-1.5">
          <legend className="mb-1 text-xs font-semibold text-ink">What should be muted?</legend>
          {SCOPES.map((value) => (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-sm border px-2 py-1.5 text-xs",
                scope === value ? "border-accent bg-accent/10" : "border-line hover:bg-raised/60",
              )}
            >
              <input
                type="radio"
                name="notification-mute-scope"
                value={value}
                checked={scope === value}
                onChange={() => setScope(value)}
                className="mt-0.5"
              />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium text-ink">{scopeLabel(value, target.type)}</span>
                <span className="min-w-0 truncate font-mono text-[11px] text-ink-faint">
                  {value === "type" ? target.type : value === "template" ? signature : exact}
                </span>
                {value === "template" && signature === exact ? (
                  <span className="text-[11px] text-ink-faint">
                    This message has no variable parts, so this rule matches the same text as “Just
                    this notification”.
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
          {currentRule ? (
            <div className="mr-auto flex min-w-0 items-center gap-2 text-[11px] text-ink-faint">
              <span className="truncate" title={notificationRuleLabel(currentRule)}>
                Muted by {notificationRuleLabel(currentRule)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  unmute(target);
                  close();
                }}
              >
                Unmute
              </Button>
            </div>
          ) : null}
          <Button size="sm" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              // `muteNotification` closes the dialog itself.
              mute(target, scope);
            }}
          >
            Mute
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
