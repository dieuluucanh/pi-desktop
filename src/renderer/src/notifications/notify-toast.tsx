/**
 * The sonner half of the notification archive (2026-10-31 UI polish plan,
 * later extended for app-owned update offers).
 *
 * Kept in its own `.tsx` file so `app-store.ts` stays JSX-free: the store decides
 * *whether* a notification may toast (class/rule/repeat), and this module owns
 * the warning/error call, the update action, and the settings gear that opens
 * the Mute dialog.
 *
 * Info notifications deliberately have no toast: their command output is
 * transcript content, exactly as in terminal Pi. The one exception is the
 * app-owned `update` class, which is a prompt rather than command output.
 */

import { Settings2 } from "lucide-react";
import { toast } from "sonner";

import type { AppNotification } from "../../../shared/notifications";

export interface NotifyToastHandlers {
  /** Opens the mute dialog for this message (warning/error toasts only). */
  onMute?: () => void;
  /** Opens the About & updates view (update toasts only). */
  onOpen?: () => void;
}

/** Shows one notification toast, if its class/type has a toast. */
export function notifyToast(notification: AppNotification, handlers: NotifyToastHandlers): void {
  if (notification.class === "update") {
    toast.info(notification.message, {
      action: {
        label: "View update",
        onClick: handlers.onOpen ?? (() => undefined),
      },
    });
    return;
  }
  if (notification.type !== "warning" && notification.type !== "error") return;
  const options = {
    action: {
      label: (
        <span className="flex items-center" title="Notification settings">
          <Settings2 className="size-3.5" aria-hidden />
          <span className="sr-only">Notification settings</span>
        </span>
      ),
      onClick: handlers.onMute ?? (() => undefined),
    },
  } as const;
  if (notification.type === "error") toast.error(notification.message, options);
  else toast.warning(notification.message, options);
}
