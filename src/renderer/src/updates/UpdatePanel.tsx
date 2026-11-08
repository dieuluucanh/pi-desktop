import { Download, ExternalLink, RefreshCw, RotateCcw } from "lucide-react";
import {
  describeUpdate,
  describeUpdateProblem,
  PI_DESKTOP_RELEASES_URL,
  updateAction,
  type UpdatePhase,
  type UpdateState,
} from "../../../shared/updates";
import { updateNotificationId } from "../../../shared/notifications";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

/**
 * About & updates → Update status (2026-11-01 update plan, moved 2026-11-08).
 *
 * The durable surface for app identity and updater state. The notification bell
 * carries the offer; every outcome — including a missing public release
 * (`no-feed`) and the raw updater error — is visible here. A locally packaged
 * build is labelled as such and its automatic check is off.
 */

const PHASE_LABELS: Record<UpdatePhase, string> = {
  unsupported: "Unsupported",
  idle: "Idle",
  checking: "Checking",
  available: "Available",
  downloading: "Downloading",
  downloaded: "Ready",
  "up-to-date": "Up to date",
  "no-feed": "No feed",
  error: "Needs attention",
};

type Tone = "neutral" | "accent" | "info" | "ok" | "warn" | "danger";

/**
 * `unsupported` is accurate but opaque on macOS, where it is a deliberate
 * policy rather than a failure: there the app updates by downloading the new
 * release, so the badge names that instead.
 */
function phaseLabel(update: Pick<UpdateState, "phase" | "unsupportedReason">): string {
  if (update.phase === "unsupported" && update.unsupportedReason === "unsigned-mac") {
    return "Manual updates";
  }
  return PHASE_LABELS[update.phase];
}

function phaseTone(phase: UpdatePhase): Tone {
  switch (phase) {
    case "available":
      return "accent";
    case "downloading":
    case "checking":
      return "info";
    case "downloaded":
    case "up-to-date":
      return "ok";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

function channelLabel(channel: string | undefined): string {
  switch (channel) {
    case "release":
      return "Release build";
    case "local":
      return "Local build";
    case "dev":
      return "Development build";
    default:
      return "Unknown build";
  }
}

function channelTone(channel: string | undefined): Tone {
  if (channel === "release") return "ok";
  if (channel === "local") return "warn";
  return "neutral";
}

function formatBuiltAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function formatCheckedAt(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

export function UpdatePanel() {
  const info = useAppStore((state) => state.info);
  const update = useAppStore((state) => state.update);
  const prefs = useAppStore((state) => state.prefs);
  const setPrefs = useAppStore((state) => state.setPrefs);
  const checkForUpdates = useAppStore((state) => state.checkForUpdates);
  const downloadUpdate = useAppStore((state) => state.downloadUpdate);
  const installUpdate = useAppStore((state) => state.installUpdate);
  const clearUpdateProblem = useAppStore((state) => state.clearUpdateProblem);
  const notifications = useAppStore((state) => state.notifications);
  const restoreUpdateNotification = useAppStore((state) => state.restoreUpdateNotification);

  const channel = info?.buildChannel ?? "unknown";
  const local = channel === "local";
  const supported = update?.supported === true;
  const phase = update?.phase ?? "idle";
  const action = update ? updateAction(update) : null;
  const checkedAt = formatCheckedAt(update?.checkedAt);
  const builtAt = formatBuiltAt(info?.builtAt);
  const versionMismatch =
    typeof info?.buildVersion === "string" && info.buildVersion !== info.version;
  const updateNotificationPresent =
    update?.version !== null &&
    update?.version !== undefined &&
    notifications.some((entry) => entry.id === updateNotificationId(update.version!));

  return (
    <section className="card flex flex-col gap-3" data-testid="updates-panel">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Update status</h2>
          <Badge tone={channelTone(channel)}>{channelLabel(channel)}</Badge>
          {update ? <Badge tone={phaseTone(update.phase)}>{phaseLabel(update)}</Badge> : null}
        </div>
        <p className="text-xs text-ink-muted">
          Pi Desktop {info ? `v${info.version}` : "(reading app info…)"}
          {info?.buildCommit ? ` · commit ${info.buildCommit}` : ""}
          {builtAt ? ` · built ${builtAt}` : ""}
        </p>
        {versionMismatch ? (
          <p className="text-xs text-warn" data-testid="settings-update-version-mismatch">
            This package reports v{info?.version}, but its build metadata says v{info?.buildVersion}
            .
          </p>
        ) : null}
      </div>

      <div className="rounded-sm border border-line bg-raised/40 px-2 py-1.5">
        <p className="text-sm">{update ? describeUpdate(update) : "Reading updater state…"}</p>
        <p className="text-xs text-ink-faint">
          {checkedAt ? `Last checked ${checkedAt}.` : "No check has run yet."}
          {phase === "error" || phase === "no-feed"
            ? " Background failures stay here and never open a banner."
            : ""}
        </p>
      </div>

      {local ? (
        <p className="text-xs text-ink-muted">
          This is a locally built app. Automatic update checks are off; a manual check only tells
          you whether a published release exists.
          {action === "download"
            ? " Installing this release replaces this local build with the published build."
            : ""}
        </p>
      ) : null}

      {phase === "downloading" ? (
        <div className="flex items-center gap-2" data-testid="settings-update-progress">
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-line" aria-hidden>
            <span
              className="block h-full bg-accent"
              style={{ width: `${update?.percent ?? 0}%` }}
            />
          </span>
          <span className="text-xs tabular-nums text-ink-faint">{update?.percent ?? 0}%</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {phase === "checking" ? (
          <Button size="sm" variant="secondary" disabled>
            Checking…
          </Button>
        ) : action === "download" ? (
          <Button size="sm" variant="primary" onClick={() => void downloadUpdate()}>
            <Download className="size-3.5" aria-hidden />
            Download{update?.version ? ` v${update.version}` : ""}
          </Button>
        ) : action === "install" ? (
          <Button size="sm" variant="primary" onClick={() => void installUpdate()}>
            <RotateCcw className="size-3.5" aria-hidden />
            Restart &amp; install
          </Button>
        ) : action === "check" ? (
          <Button size="sm" variant="secondary" onClick={() => void checkForUpdates()}>
            <RefreshCw className="size-3.5" aria-hidden />
            {phase === "error" || phase === "no-feed" ? "Check again" : "Check now"}
          </Button>
        ) : null}

        {action === "download" || action === "install" ? (
          <Button size="sm" variant="ghost" onClick={() => void checkForUpdates()}>
            Check again
          </Button>
        ) : null}

        {phase === "available" &&
        update?.version !== null &&
        update?.version !== undefined &&
        prefs.updates.notifiedVersion === update.version &&
        !updateNotificationPresent ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={!prefs.notifications.classes.update}
            title={
              prefs.notifications.classes.update
                ? "Raise the update notification again"
                : "App update notifications are off in Settings → Notifications"
            }
            onClick={() => restoreUpdateNotification()}
          >
            Notify me again
          </Button>
        ) : null}

        <Button
          size="sm"
          variant="ghost"
          onClick={() => void window.pi?.openExternal(PI_DESKTOP_RELEASES_URL)}
        >
          <ExternalLink className="size-3.5" aria-hidden />
          Open releases page
        </Button>
      </div>

      {update?.error ? (
        <div
          className="rounded-sm border border-warn/50 bg-warn/10 px-2 py-1.5 text-xs"
          data-testid="settings-update-problem"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-warn">{describeUpdateProblem(update.problemKind)}</p>
              <details className="mt-1 text-ink-muted">
                <summary className="cursor-pointer">Technical details</summary>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px]">
                  {update.error}
                </pre>
              </details>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void clearUpdateProblem()}>
              Dismiss message
            </Button>
          </div>
        </div>
      ) : null}

      {update?.releaseNotes ? (
        <details className="text-xs text-ink-muted">
          <summary className="cursor-pointer text-sm font-medium text-ink">Release notes</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">
            {update.releaseNotes}
          </pre>
        </details>
      ) : null}

      <div className="flex items-center justify-between gap-3 rounded-sm border border-line bg-raised/40 px-2 py-1.5">
        <div className="min-w-0">
          <p className="text-sm">Automatic checks</p>
          <p className="text-xs text-ink-faint">
            {local
              ? "Off for local builds: this package is not on the update feed."
              : "Checks once after launch. Failures stay in this card — they never open a banner."}
          </p>
        </div>
        <Switch
          checked={prefs.updates.autoCheck && supported && !local}
          disabled={local || !supported}
          onCheckedChange={(autoCheck) => setPrefs({ updates: { ...prefs.updates, autoCheck } })}
          aria-label="Check for updates automatically"
        />
      </div>
    </section>
  );
}
