import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, FolderOpen, RefreshCw, Search } from "lucide-react";
import {
  PACKAGE_GALLERY_URL,
  RECOMMENDED_PACKAGES,
  isRecommendedInstalled,
} from "../../../shared/recommended-packages";
import { type ResourceKind, type ResourceSummary } from "../../../shared/resources";
import { OfficeSetupPanel } from "../office/OfficeSetupPanel";
import { PackagesSection } from "../extensions/PackagesSection";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";

/**
 * Extensions hub (plan step 13).
 *
 * Lists what Pi actually loaded — extensions, skills, prompt templates and
 * themes — with source, scope, provenance, contributed tools/commands/
 * shortcuts/flags and loader diagnostics. Enable/disable is a settings-array
 * override (`-path` / `+path`), so it is reversible and visible to terminal Pi;
 * "Reload runtime" asks the live session to reload and reports what changed.
 *
 * Integrations still hosts the shipped Pi for Office wizard unchanged (plan
 * D-A10); step 19 turns that into a full card.
 */

const KIND_LABELS: Record<ResourceKind, string> = {
  extensions: "Extensions",
  skills: "Skills",
  prompts: "Prompt templates",
  themes: "Themes",
};

const KIND_HINTS: Record<ResourceKind, string> = {
  extensions: "Loaded from the profile, the project and installed packages.",
  skills: "Injected into a session through `skill:<name>` commands.",
  prompts: "Prompt templates, invokable as `/name` with their arguments.",
  themes: "Theme JSON files; the active theme drives the app chrome.",
};

function matchesQuery(resource: ResourceSummary, query: string): boolean {
  if (query.trim().length === 0) return true;
  const needle = query.trim().toLowerCase();
  return [resource.name, resource.source, resource.scope, resource.origin, resource.path]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

function contributionLabel(kind: string): string {
  if (kind === "tool") return "tool";
  if (kind === "command") return "command";
  if (kind === "shortcut") return "key";
  return "flag";
}

export function ExtensionsView() {
  const resources = useAppStore((state) => state.resources);
  const resourcesLoaded = useAppStore((state) => state.resourcesLoaded);
  const resourcesBusy = useAppStore((state) => state.resourcesBusy);
  const resourcesError = useAppStore((state) => state.resourcesError);
  const resourcesChange = useAppStore((state) => state.resourcesChange);
  const loadResources = useAppStore((state) => state.loadResources);
  const reloadResources = useAppStore((state) => state.reloadResources);
  const toggleResource = useAppStore((state) => state.toggleResource);
  const installRecommendedPackage = useAppStore((state) => state.installRecommendedPackage);
  const packagesBusy = useAppStore((state) => state.packagesBusy);
  const settings = useAppStore((state) => state.settings);
  const loadSettings = useAppStore((state) => state.loadSettings);

  const [query, setQuery] = useState("");

  useEffect(() => {
    void loadSettings();
    void loadResources();
    void useAppStore.getState().loadPackages();
  }, [loadSettings, loadResources]);

  const installedPackages = useMemo(() => {
    const scopes = settings ?? { global: {}, project: {} };
    const fromScope = (document: Record<string, unknown>): string[] => {
      const value = document.packages;
      return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
    };
    return [...fromScope(scopes.global), ...fromScope(scopes.project)];
  }, [settings]);

  const groups = useMemo(() => {
    const byKind: Record<ResourceKind, ResourceSummary[]> = {
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    };
    for (const resource of resources.resources) {
      if (matchesQuery(resource, query)) byKind[resource.kind].push(resource);
    }
    return byKind;
  }, [resources.resources, query]);

  const diagnostics = resources.diagnostics;
  const runtimeErrors = resources.runtimeErrors;

  const reveal = (path: string): void => {
    void window.pi?.revealPath(path);
  };

  const openGallery = (): void => {
    void window.pi?.openExternal(PACKAGE_GALLERY_URL);
  };

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-5 overflow-y-auto px-8 py-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Extensions</h1>
          <p className="text-sm text-ink-muted">
            Pi loads extensions, skills, prompt templates and themes from the shared profile, the
            project and installed packages — exactly as terminal Pi does.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost" onClick={openGallery}>
            <ExternalLink className="size-3" aria-hidden />
            pi.dev/packages
          </Button>
          <Button
            size="sm"
            disabled={resourcesBusy}
            onClick={() => void reloadResources()}
            aria-label="Reload runtime"
          >
            <RefreshCw className="size-3" aria-hidden />
            Reload runtime
          </Button>
        </div>
      </header>

      <label className="flex items-center gap-2 rounded-sm border border-line px-2 py-1">
        <Search className="size-3 text-ink-faint" aria-hidden />
        <input
          aria-label="Search resources"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search extensions, skills, prompts and themes"
          className="w-full bg-transparent text-xs text-ink outline-none"
        />
      </label>

      {resourcesError ? (
        <p className="banner banner--error text-xs" role="alert">
          {resourcesError}
        </p>
      ) : null}

      {resourcesChange ? (
        <section className="banner banner--info flex flex-col gap-1 text-xs" data-testid="changes">
          <strong>Reloaded.</strong>
          {resourcesChange.added.length > 0 ? (
            <span>Added: {resourcesChange.added.map((entry) => entry.name).join(", ")}</span>
          ) : null}
          {resourcesChange.removed.length > 0 ? (
            <span>Removed: {resourcesChange.removed.map((entry) => entry.name).join(", ")}</span>
          ) : null}
          {resourcesChange.changed.length > 0 ? (
            <span>
              Changed:{" "}
              {resourcesChange.changed
                .map((entry) => `${entry.after.name} (${entry.reason})`)
                .join(", ")}
            </span>
          ) : null}
        </section>
      ) : null}

      {!resourcesLoaded ? (
        <p className="text-xs text-ink-faint">Reading resources from Pi…</p>
      ) : null}
      {resourcesLoaded && resources.resources.length === 0 && !resourcesError ? (
        <p className="text-xs text-ink-faint">
          Pi reported no resources. Install a package below, or add a path to the{" "}
          <code className="font-mono">extensions</code> / <code className="font-mono">skills</code>{" "}
          settings.
        </p>
      ) : null}

      {diagnostics.length > 0 || runtimeErrors.length > 0 ? (
        <section className="card flex flex-col gap-2" data-testid="diagnostics">
          <h2 className="text-sm font-semibold">Diagnostics</h2>
          <Separator />
          <ul className="flex flex-col gap-1 text-xs">
            {diagnostics.map((entry, index) => (
              <li key={`diag-${index}`} className="flex flex-col">
                <span className="text-ink">
                  <Badge tone={entry.type === "error" ? "danger" : "warn"}>{entry.type}</Badge>{" "}
                  {entry.message}
                </span>
                {entry.path ? (
                  <span className="truncate font-mono text-[10px] text-ink-faint">
                    {entry.path}
                  </span>
                ) : null}
              </li>
            ))}
            {runtimeErrors.map((entry, index) => (
              <li key={`err-${index}`} className="flex flex-col">
                <span className="text-ink">
                  <Badge tone="danger">{entry.event}</Badge> {entry.error}
                </span>
                {entry.extensionPath ? (
                  <span className="truncate font-mono text-[10px] text-ink-faint">
                    {entry.extensionPath}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {(["extensions", "skills", "prompts", "themes"] as const).map((kind) => (
        <section key={kind} className="card flex flex-col gap-2" data-testid={`kind-${kind}`}>
          <div>
            <h2 className="text-sm font-semibold">{KIND_LABELS[kind]}</h2>
            <p className="text-xs text-ink-muted">{KIND_HINTS[kind]}</p>
          </div>
          <Separator />
          {groups[kind].length === 0 ? (
            <p className="text-xs text-ink-faint">
              {resources.resources.some((entry) => entry.kind === kind)
                ? "No match for the search."
                : "None loaded."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {groups[kind].map((resource) => (
                <ResourceRow
                  key={resource.id}
                  resource={resource}
                  busy={resourcesBusy}
                  onToggle={(enabled) => void toggleResource(resource, enabled)}
                  onReveal={() => reveal(resource.path)}
                />
              ))}
            </ul>
          )}
        </section>
      ))}

      {resources.overrides.length > 0 ? (
        <section className="card flex flex-col gap-2" data-testid="overrides">
          <div>
            <h2 className="text-sm font-semibold">Pattern overrides</h2>
            <p className="text-xs text-ink-muted">
              Glob and force-include entries found in the settings arrays. Edit them in Settings →
              Resources for anything finer-grained than a single resource.
            </p>
          </div>
          <Separator />
          <ul className="flex flex-col gap-1 text-xs">
            {resources.overrides.map((entry) => (
              <li key={`${entry.scope}-${entry.kind}-${entry.entry}`} className="font-mono">
                <Badge tone="neutral">{entry.scope}</Badge> {entry.kind}: {entry.entry}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <PackagesSection />

      <RecommendedSection
        packages={installedPackages}
        busy={packagesBusy}
        onInstall={(entry) => installRecommendedPackage(entry)}
        onRevealSettings={() => useAppStore.getState().setView("settings")}
      />

      <section className="flex flex-col gap-3" data-testid="integrations">
        <div>
          <h2 className="text-sm font-semibold">Integrations</h2>
          <p className="text-xs text-ink-muted">
            Optional add-ons. The app is fully usable without any of them.
          </p>
        </div>
        <OfficeSetupPanel />
      </section>
    </div>
  );
}

function ResourceRow({
  resource,
  busy,
  onToggle,
  onReveal,
}: {
  resource: ResourceSummary;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onReveal: () => void;
}) {
  const contributions = resource.contributed ?? [];
  const temporary = resource.scope === "temporary";
  return (
    <li className="flex flex-col gap-1 rounded-sm border border-line px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-xs font-medium text-ink">{resource.name}</span>
          <Badge tone="neutral">{resource.scope}</Badge>
          <Badge tone="neutral">{resource.origin}</Badge>
          {resource.source && resource.source !== "unknown" ? (
            <span className="truncate font-mono text-[10px] text-ink-faint">{resource.source}</span>
          ) : null}
          {!resource.enabled ? <Badge tone="warn">disabled</Badge> : null}
          {resource.argumentHint ? <Badge tone="neutral">{resource.argumentHint}</Badge> : null}
          {resource.disableModelInvocation ? <Badge tone="neutral">explicit only</Badge> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={onReveal}
            aria-label={`Reveal ${resource.name}`}
          >
            <FolderOpen className="size-3" aria-hidden />
          </Button>
          <Switch
            checked={resource.enabled}
            disabled={busy || temporary}
            title={temporary ? "Temporary resources cannot be toggled" : undefined}
            aria-label={`${resource.enabled ? "Disable" : "Enable"} ${resource.name}`}
            onCheckedChange={onToggle}
          />
        </div>
      </div>
      {resource.description ? (
        <p className="text-xs text-ink-muted">{resource.description}</p>
      ) : null}
      <span className="truncate font-mono text-[10px] text-ink-faint">{resource.path}</span>
      {resource.error ? (
        <p className="banner banner--error text-xs" role="alert">
          {resource.error}
        </p>
      ) : null}
      {contributions.length > 0 ? (
        <ul className="flex flex-wrap gap-1" data-testid={`contributions-${resource.id}`}>
          {contributions.map((entry) => (
            <li key={`${entry.kind}-${entry.name}`}>
              <Badge tone="accent">
                {contributionLabel(entry.kind)}: {entry.name}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function RecommendedSection({
  packages,
  busy,
  onInstall,
  onRevealSettings,
}: {
  packages: readonly string[];
  busy: boolean;
  onInstall: (entry: (typeof RECOMMENDED_PACKAGES)[number]) => void;
  onRevealSettings: () => void;
}) {
  return (
    <section className="card flex flex-col gap-2" data-testid="recommended">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Recommended for Pi Desktop</h2>
          <p className="text-xs text-ink-muted">
            A reviewed set of packages. Anything else installs from the gallery, or from Settings →
            Resources.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onRevealSettings}>
          Settings
        </Button>
      </div>
      <Separator />
      <ul className="flex flex-col gap-2">
        {RECOMMENDED_PACKAGES.map((entry) => {
          const installed = isRecommendedInstalled(entry, packages);
          return (
            <li
              key={entry.id}
              className="flex items-center justify-between gap-3 rounded-sm border border-line px-3 py-2"
              data-testid={`recommended-${entry.id}`}
            >
              <div className="flex min-w-0 flex-col">
                <span className="flex items-center gap-2 text-xs font-medium text-ink">
                  {entry.name}
                  <Badge tone={entry.integration ? "accent" : "neutral"}>{entry.provides}</Badge>
                  {entry.verifiableInRepo ? <Badge tone="ok">pinned in repo</Badge> : null}
                </span>
                <span className="text-xs text-ink-muted">{entry.description}</span>
                <span className="truncate font-mono text-[10px] text-ink-faint">
                  {entry.source}
                </span>
              </div>
              {installed ? (
                <span className="flex shrink-0 items-center gap-1 text-xs text-ok">
                  <Check className="size-3" aria-hidden /> Installed
                </span>
              ) : (
                <Button size="sm" disabled={busy} onClick={() => onInstall(entry)}>
                  Install
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-ink-faint">
        Installing runs the package manager with the source shown above; nothing is installed
        silently.
      </p>
    </section>
  );
}
