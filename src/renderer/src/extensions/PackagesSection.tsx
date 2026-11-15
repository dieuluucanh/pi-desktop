import { useMemo, useState } from "react";
import { Download, Loader2, Pin, PinOff, RefreshCw, Trash2 } from "lucide-react";
import {
  packageUpdateIdentity,
  pinnedPackageSource,
  unpinnedPackageSource,
  type PackageScope,
  type PackageSummary,
  type PackageUpdateSummary,
} from "../../../shared/packages";
import { isHostBackedTab } from "../../../shared/session-ipc";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";

/**
 * Installed packages (plan step 14), with the available-update channel (plan
 * step 6).
 *
 * The list is what Pi is configured to load; installs, updates and removals go
 * through the control host's package manager. Anything that changes the system
 * opens the consent dialog first — this section never calls the host directly
 * for an install.
 *
 * The update sweep is ambient (sidebar dot, bell) and this card is where the
 * detail lives: what is outdated, by how much, when it was last checked, and
 * why a row deliberately cannot be updated (a pin).
 */

function scopeLabel(scope: PackageScope): string {
  return scope === "project" ? "project" : "user";
}

function kindLabel(summary: PackageSummary): string {
  if (summary.kind === "git") return "git";
  if (summary.kind === "path") return "path";
  return "npm";
}

/** Coarse, dependency-free relative time for the "checked …" line. */
function checkedAgo(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** The first line of a host failure, so a hint body stays out of the status row. */
function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? text;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/** The update a row would install, matched by identity so pin/unpin agree. */
function updateFor(
  summary: PackageSummary,
  updates: readonly PackageUpdateSummary[],
): PackageUpdateSummary | null {
  // A pin is a deliberate choice: the sweep skips it, so the row must not
  // suggest an update it would not perform (D9).
  if (summary.pinned) return null;
  const identity = packageUpdateIdentity(summary);
  return updates.find((entry) => packageUpdateIdentity(entry) === identity) ?? null;
}

export function PackagesSection() {
  const packages = useAppStore((state) => state.packages);
  const loaded = useAppStore((state) => state.packagesLoaded);
  const busy = useAppStore((state) => state.packagesBusy);
  const error = useAppStore((state) => state.packagesError);
  const progress = useAppStore((state) => state.packageProgress);
  const loadPackages = useAppStore((state) => state.loadPackages);
  const requestPackageInstall = useAppStore((state) => state.requestPackageInstall);
  const requestPackageUpdate = useAppStore((state) => state.requestPackageUpdate);
  const removePackage = useAppStore((state) => state.removePackage);
  const pinPackage = useAppStore((state) => state.pinPackage);
  const unpinPackage = useAppStore((state) => state.unpinPackage);

  const updates = useAppStore((state) => state.packageUpdates);
  const updatesBusy = useAppStore((state) => state.packageUpdatesBusy);
  const updatesError = useAppStore((state) => state.packageUpdatesError);
  const updatesOffline = useAppStore((state) => state.packageUpdatesOffline);
  const updatesUnavailable = useAppStore((state) => state.packageUpdatesUnavailable);
  const updatesCheckedAt = useAppStore((state) => state.packageUpdatesCheckedAt);
  const checkPackageUpdates = useAppStore((state) => state.checkPackageUpdates);
  const autoCheck = useAppStore((state) => state.prefs.packages.autoCheck);
  const setPackageCheckPrefs = useAppStore((state) => state.setPackageCheckPrefs);
  const packagesMutatedAt = useAppStore((state) => state.packagesMutatedAt);
  const dismissPackageReloadHint = useAppStore((state) => state.dismissPackageReloadHint);
  const reloadResources = useAppStore((state) => state.reloadResources);
  const tabs = useAppStore((state) => state.tabs);

  const [source, setSource] = useState("");
  const [scope, setScope] = useState<PackageScope>("user");

  const sorted = useMemo(
    () =>
      [...packages].sort(
        (left, right) =>
          left.scope.localeCompare(right.scope) || left.name.localeCompare(right.name),
      ),
    [packages],
  );

  const updateCount = updates.length;
  const checked = updatesCheckedAt === null ? null : checkedAgo(updatesCheckedAt);
  let status: string;
  if (updatesUnavailable) {
    status = "Update checks are unavailable in this build.";
  } else if (updatesBusy) {
    status = "Checking for updates…";
  } else if (updatesOffline) {
    status = "Offline — update checks are paused.";
  } else if (updatesError) {
    status = `Could not check for updates: ${firstLine(updatesError)}`;
  } else if (updateCount > 0) {
    status = `${updateCount} update${updateCount === 1 ? "" : "s"} available${
      checked ? ` · checked ${checked}` : ""
    }`;
  } else if (checked) {
    status = `Up to date · checked ${checked}`;
  } else {
    status = "Not checked yet.";
  }

  const hasHostTab = tabs.some((tab) => isHostBackedTab(tab.kind));

  const install = (): void => {
    if (source.trim().length === 0) return;
    requestPackageInstall(source, scope);
    setSource("");
  };

  return (
    <section className="card flex flex-col gap-2" data-testid="packages">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Packages</h2>
          <p className="text-xs text-ink-muted">
            Installed through Pi&apos;s own package manager into the shared profile or a project.
            Extensions in a package run with your full system access.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void loadPackages({ refresh: true })}
            aria-label="Reload packages"
          >
            <RefreshCw className="size-3" aria-hidden />
          </Button>
          <Button
            size="sm"
            variant={updateCount > 0 ? "primary" : "secondary"}
            disabled={busy || packages.length === 0}
            onClick={() => requestPackageUpdate(null, "user")}
          >
            {updateCount > 0 ? `Update all (${updateCount})` : "Update all"}
          </Button>
        </div>
      </div>
      <Separator />

      <div
        className="flex flex-wrap items-center justify-between gap-2"
        data-testid="package-check-status"
      >
        <p className="text-xs text-ink-muted">{status}</p>
        <div className="flex shrink-0 items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            <Switch
              checked={autoCheck}
              onCheckedChange={(next) => setPackageCheckPrefs({ autoCheck: next })}
              aria-label="Check for updates automatically"
            />
            Check automatically
          </label>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || updatesBusy}
            onClick={() => void checkPackageUpdates({ force: true })}
          >
            Check now
          </Button>
        </div>
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          install();
        }}
      >
        <input
          className="h-7 min-w-0 flex-1 rounded-sm border border-line bg-surface px-2 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:border-accent"
          placeholder="npm:@scope/name, a GitHub URL or a local path"
          aria-label="Package source"
          value={source}
          onChange={(event) => setSource(event.target.value)}
        />
        <div className="flex items-center gap-1" role="group" aria-label="Install scope">
          {(["user", "project"] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={scope === option ? "primary" : "ghost"}
              aria-pressed={scope === option}
              onClick={() => setScope(option)}
            >
              {scopeLabel(option)}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={busy || source.trim().length === 0}
        >
          <Download className="size-3" aria-hidden />
          Install
        </Button>
      </form>

      {progress ? (
        <p className="text-xs text-ink-muted" data-testid="package-progress">
          {progress.phase === "start" ? "Starting" : "Working"} {progress.action} of{" "}
          <span className="font-mono">{progress.source}</span>
          {progress.message ? ` — ${progress.message}` : ""}
          {progress.percent !== null ? ` (${progress.percent}%)` : ""}
        </p>
      ) : null}

      {error ? (
        <p className="banner banner--error whitespace-pre-wrap text-xs" role="alert">
          {error}
        </p>
      ) : null}

      {!loaded ? (
        <p className="text-xs text-ink-muted">Reading the configured packages…</p>
      ) : sorted.length === 0 ? (
        <p className="text-xs text-ink-muted" data-testid="packages-empty">
          No packages are configured yet. Install one above, or from the recommended set below.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5" data-testid="package-list">
          {sorted.map((entry) => (
            <PackageRow
              key={`${entry.scope}-${entry.source}`}
              summary={entry}
              update={updateFor(entry, updates)}
              working={progress?.source === entry.source}
              busy={busy}
              onPin={() => pinPackage(entry)}
              onUnpin={() => unpinPackage(entry)}
              onUpdate={() => requestPackageUpdate(entry.source, entry.scope)}
              onRemove={() => void removePackage(entry)}
            />
          ))}
        </ul>
      )}

      {packagesMutatedAt !== null && hasHostTab ? (
        <div
          className="banner banner--info flex flex-wrap items-center justify-between gap-2 text-xs"
          data-testid="package-reload-hint"
        >
          <span>Package code changed. Running sessions keep the version they loaded.</span>
          <span className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="secondary" onClick={() => void reloadResources()}>
              Reload runtime
            </Button>
            <Button size="sm" variant="ghost" onClick={dismissPackageReloadHint}>
              Dismiss
            </Button>
          </span>
        </div>
      ) : null}
    </section>
  );
}

function PackageRow({
  summary,
  update,
  working,
  busy,
  onPin,
  onUnpin,
  onUpdate,
  onRemove,
}: {
  summary: PackageSummary;
  update: PackageUpdateSummary | null;
  working: boolean;
  busy: boolean;
  onPin: () => void;
  onUnpin: () => void;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  const pinTarget = pinnedPackageSource(summary);
  const unpinTarget = unpinnedPackageSource(summary);
  // A pin is not a dead end: Unpin is the action that makes Update meaningful.
  const pinnedUpdate = summary.pinned && summary.installed;
  const actionLabel = summary.installed ? "Update" : "Install";
  const actionTitle = pinnedUpdate
    ? `Pinned to ${summary.version ?? "this version"} — unpin to follow latest`
    : update?.latestVersion
      ? `Update to ${update.latestVersion}`
      : undefined;

  return (
    <li
      className="flex items-center justify-between gap-3 rounded-sm border border-line px-3 py-2"
      data-testid={`package-${summary.source}`}
      aria-busy={working}
    >
      <div className="flex min-w-0 flex-col">
        <span className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-ink">
          <span className="truncate">{summary.name}</span>
          <Badge tone="neutral">{kindLabel(summary)}</Badge>
          <Badge tone={summary.scope === "project" ? "accent" : "neutral"}>
            {scopeLabel(summary.scope)}
          </Badge>
          {summary.pinned ? <Badge tone="ok">pinned</Badge> : null}
          {summary.filtered ? <Badge tone="warn">filtered</Badge> : null}
          {summary.installed ? (
            <Badge tone="ok">installed{summary.version ? ` ${summary.version}` : ""}</Badge>
          ) : (
            <Badge tone="warn">not installed</Badge>
          )}
          {update ? (
            <Badge
              tone="accent"
              data-testid={`package-update-badge-${summary.source}`}
            >{`${update.latestVersion ? `${update.latestVersion} ` : ""}available`}</Badge>
          ) : null}
        </span>
        <span className="truncate font-mono text-[10px] text-ink-faint">{summary.source}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {working ? (
          <Loader2
            className="size-3 animate-spin text-ink-muted"
            aria-hidden
            data-testid="package-row-spinner"
          />
        ) : null}
        {unpinTarget && summary.pinned ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onUnpin} title="Follow latest">
            <PinOff className="size-3" aria-hidden />
          </Button>
        ) : null}
        {pinTarget && !summary.pinned ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onPin}
            title={`Pin to ${summary.version}`}
          >
            <Pin className="size-3" aria-hidden />
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={update ? "primary" : "secondary"}
          disabled={busy || pinnedUpdate}
          onClick={onUpdate}
          title={actionTitle}
          data-testid={`package-update-${summary.source}`}
        >
          {actionLabel}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={busy}
          onClick={onRemove}
          aria-label={`Remove ${summary.name}`}
        >
          <Trash2 className="size-3" aria-hidden />
        </Button>
      </div>
    </li>
  );
}
