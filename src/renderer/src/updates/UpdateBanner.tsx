import { Download, RefreshCw, RotateCcw } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useAppStore } from "../state/app-store";

/**
 * The in-app update banner (plan step 26).
 *
 * Only the actionable phases render: an offer (Download), progress, a ready
 * build (Restart & install) and a failure (Retry). A check that finds nothing
 * new says so in the status bar instead of leaving a banner on screen. Dev
 * builds report `supported: false`, so the banner stays absent — the Help menu
 * explains why when asked.
 *
 * Since the in-app title bar was removed (minimal-session-ui step 1), the
 * banner is a slim full-width row at the top of the app shell. It returns
 * `null` when there is nothing actionable, so it costs no layout when idle.
 */
const ROW_CLASS = "flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5";

export function UpdateBanner() {
  const update = useAppStore((state) => state.update);
  const downloadUpdate = useAppStore((state) => state.downloadUpdate);
  const installUpdate = useAppStore((state) => state.installUpdate);

  if (!update) return null;
  const version = update.version ? `v${update.version}` : "an update";

  if (update.phase === "available") {
    return (
      <div className={ROW_CLASS} role="status" data-testid="update-banner">
        <Badge tone="accent">{version} available</Badge>
        <Button size="sm" variant="secondary" onClick={() => void downloadUpdate()}>
          <Download className="size-3.5" aria-hidden />
          Download
        </Button>
      </div>
    );
  }

  if (update.phase === "downloading") {
    const percent = update.percent ?? 0;
    return (
      <div className={ROW_CLASS} role="status" data-testid="update-banner">
        <Badge tone="neutral">Downloading {percent}%</Badge>
        <span
          className="h-1 w-24 overflow-hidden rounded-full bg-line"
          aria-hidden
          data-testid="update-progress"
        >
          <span className="block h-full bg-accent" style={{ width: `${percent}%` }} />
        </span>
      </div>
    );
  }

  if (update.phase === "downloaded") {
    return (
      <div className={ROW_CLASS} role="status" data-testid="update-banner">
        <Badge tone="ok">{version} ready</Badge>
        <Button size="sm" variant="primary" onClick={() => void installUpdate()}>
          <RotateCcw className="size-3.5" aria-hidden />
          Restart &amp; install
        </Button>
      </div>
    );
  }

  if (update.phase === "error") {
    return (
      <div className={ROW_CLASS} role="status" data-testid="update-banner">
        <Badge tone="danger">Update failed</Badge>
        <Button size="sm" variant="ghost" onClick={() => void downloadUpdate()}>
          <RefreshCw className="size-3.5" aria-hidden />
          Retry
        </Button>
      </div>
    );
  }

  return null;
}
