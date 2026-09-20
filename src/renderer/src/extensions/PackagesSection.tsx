import { useMemo, useState } from "react";
import { Download, Pin, PinOff, RefreshCw, Trash2 } from "lucide-react";
import {
  pinnedPackageSource,
  unpinnedPackageSource,
  type PackageScope,
  type PackageSummary,
} from "../../../shared/packages";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";

/**
 * Installed packages (plan step 14).
 *
 * The list is what Pi is configured to load; installs, updates and removals go
 * through the control host's package manager. Anything that changes the system
 * opens the consent dialog first — this section never calls the host directly
 * for an install.
 */

function scopeLabel(scope: PackageScope): string {
  return scope === "project" ? "project" : "user";
}

function kindLabel(summary: PackageSummary): string {
  if (summary.kind === "git") return "git";
  if (summary.kind === "path") return "path";
  return "npm";
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
            variant="secondary"
            disabled={busy || packages.length === 0}
            onClick={() => requestPackageUpdate(null, "user")}
          >
            Update all
          </Button>
        </div>
      </div>
      <Separator />

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
              busy={busy}
              onPin={() => pinPackage(entry)}
              onUnpin={() => unpinPackage(entry)}
              onUpdate={() => requestPackageUpdate(entry.source, entry.scope)}
              onRemove={() => void removePackage(entry)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PackageRow({
  summary,
  busy,
  onPin,
  onUnpin,
  onUpdate,
  onRemove,
}: {
  summary: PackageSummary;
  busy: boolean;
  onPin: () => void;
  onUnpin: () => void;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  const pinTarget = pinnedPackageSource(summary);
  const unpinTarget = unpinnedPackageSource(summary);
  return (
    <li
      className="flex items-center justify-between gap-3 rounded-sm border border-line px-3 py-2"
      data-testid={`package-${summary.source}`}
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
        </span>
        <span className="truncate font-mono text-[10px] text-ink-faint">{summary.source}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
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
        <Button size="sm" variant="secondary" disabled={busy} onClick={onUpdate}>
          Update
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
