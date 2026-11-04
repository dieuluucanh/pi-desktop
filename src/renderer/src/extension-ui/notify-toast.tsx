/**
 * The sonner half of `ctx.ui.notify` (2026-10-31 UI polish plan).
 *
 * Kept in its own `.tsx` file so `app-store.ts` stays JSX-free: the store decides
 * *whether* a notification may toast (muted/repeated), and this module owns the
 * warning/error call plus the settings gear that opens the Mute dialog.
 *
 * Info notifications deliberately have no toast: their command output is
 * transcript content, exactly as in terminal Pi.
 */

import { Settings2 } from "lucide-react";
import { toast } from "sonner";

import type { ExtensionNotification } from "../../../shared/extension-ui";

/** Shows one warning/error toast with a gear that calls `onMute`. */
export function notifyToast(notification: ExtensionNotification, onMute: () => void): void {
  if (notification.type !== "warning" && notification.type !== "error") return;
  const options = {
    action: {
      label: (
        <span className="flex items-center" title="Notification settings">
          <Settings2 className="size-3.5" aria-hidden />
          <span className="sr-only">Notification settings</span>
        </span>
      ),
      onClick: onMute,
    },
  } as const;
  if (notification.type === "error") toast.error(notification.message, options);
  else toast.warning(notification.message, options);
}
