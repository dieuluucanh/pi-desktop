import { X } from "lucide-react";
import type { UpdateState } from "../../../shared/updates";
import { useAppStore } from "../state/app-store";

/**
 * The app's only update affordance outside Settings (2026-11-01 update plan).
 *
 * It lives inside the existing status bar instead of a full-width banner: an
 * available build is a compact link, a download/check is a short label, and a
 * ready build says "Restart to update". `×` persists a per-version dismissal, so
 * the same offer never nags again; a later version notifies again.
 */
const LINK_CLASS = "rounded-xs px-1 text-[11px] hover:bg-raised";

function labelFor(
  update: UpdateState,
): { label: string; tone: string; dismissible: boolean; title: string } | null {
  switch (update.phase) {
    case "available": {
      const label = update.version ? `Update v${update.version}` : "Update available";
      return {
        label,
        tone: "text-accent",
        dismissible: true,
        title: `${label}. Open Settings → About & updates.`,
      };
    }
    case "downloaded": {
      const label = "Restart to update";
      return {
        label,
        tone: "text-ok",
        dismissible: true,
        title: `Pi Desktop${update.version ? ` ${update.version}` : ""} is ready. Open Settings → About & updates to restart.`,
      };
    }
    case "downloading":
      return {
        label: `Updating ${update.percent ?? 0}%`,
        tone: "text-info",
        dismissible: false,
        title: "Downloading the update. Open Settings → About & updates for details.",
      };
    case "checking":
      return update.lastCheckWasAutomatic
        ? null
        : {
            label: "Checking for updates…",
            tone: "text-ink-muted",
            dismissible: false,
            title: "Checking for updates. Open Settings → About & updates.",
          };
    default:
      return null;
  }
}

export function UpdateStatusButton() {
  const update = useAppStore((state) => state.update);
  const dismissedVersion = useAppStore((state) => state.prefs.updates.dismissedVersion);
  const openUpdateSettings = useAppStore((state) => state.openUpdateSettings);
  const dismissUpdateNotification = useAppStore((state) => state.dismissUpdateNotification);

  if (!update) return null;
  const dismissed = update.version !== null && update.version === dismissedVersion;
  if (dismissed && (update.phase === "available" || update.phase === "downloaded")) return null;

  const view = labelFor(update);
  if (!view) return null;

  return (
    <span className="flex items-center gap-0.5" data-testid="status-update">
      <button
        type="button"
        className={`${LINK_CLASS} ${view.tone}`}
        title={view.title}
        onClick={() => openUpdateSettings()}
      >
        {view.label}
      </button>
      {view.dismissible ? (
        <button
          type="button"
          className="rounded-xs p-0.5 hover:bg-raised hover:text-ink"
          aria-label="Dismiss update notification"
          title="Hide this version's notification"
          onClick={dismissUpdateNotification}
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}
