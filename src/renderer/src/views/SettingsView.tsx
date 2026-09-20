import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { SettingsScope } from "../../../shared/settings-schema";
import {
  groupSettingsFields,
  settingsChangesFromDefaults,
  settingsDefaultsDocument,
  type SettingsField,
} from "../../../shared/settings-schema";
import {
  describeSettingsValue,
  settingsValueProvenance,
  splitAdvancedFields,
} from "../../../shared/settings-view";
import type { ThemeSetting, ViewMode } from "../../../shared/prefs";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Separator } from "../ui/separator";
import { SettingsFieldEditor } from "../settings/SettingsFieldEditor";

/**
 * Settings (plan step 12).
 *
 * Two deliberately separate halves: **app preferences** (real, persisted in
 * `app-state.json`, never in Pi's profile) and **Pi settings**, which mirror
 * `settings.json` through the control host. Every Pi key comes from the shared
 * schema, which is pinned to Pi's own `docs/settings.md` by a test — the UI
 * cannot invent a setting or drop one.
 *
 * A write goes through `SettingsManager` (named setter) or an atomic,
 * validated document edit; a malformed file is surfaced here, never overwritten.
 */

const THEMES: readonly ThemeSetting[] = ["dark", "light", "system"];
const VIEW_MODES: readonly ViewMode[] = ["normal", "verbose", "summary"];

export function SettingsView() {
  const prefs = useAppStore((state) => state.prefs);
  const setPrefs = useAppStore((state) => state.setPrefs);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const info = useAppStore((state) => state.info);
  const project = useAppStore((state) => state.project);
  const settings = useAppStore((state) => state.settings);
  const settingsLoaded = useAppStore((state) => state.settingsLoaded);
  const settingsBusy = useAppStore((state) => state.settingsBusy);
  const settingsError = useAppStore((state) => state.settingsError);
  const settingsErrors = useAppStore((state) => state.settingsErrors);
  const settingsProjectTrusted = useAppStore((state) => state.settingsProjectTrusted);
  const settingsExternalEdit = useAppStore((state) => state.settingsExternalEdit);
  const loadSettings = useAppStore((state) => state.loadSettings);
  const setSetting = useAppStore((state) => state.setSetting);
  const writeRawSettings = useAppStore((state) => state.writeRawSettings);
  const reloadSettings = useAppStore((state) => state.reloadSettings);
  const checkExternalSettingsEdit = useAppStore((state) => state.checkExternalSettingsEdit);
  const resetSetting = useAppStore((state) => state.resetSetting);
  const resetScope = useAppStore((state) => state.resetScope);
  const openTrustPrompt = useAppStore((state) => state.openTrustPrompt);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [rawScope, setRawScope] = useState<SettingsScope>("global");
  const [rawDraft, setRawDraft] = useState("");
  const [rawError, setRawError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState<SettingsScope | null>(null);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // An edit made by terminal Pi is detected by mtime, on entry and on focus.
  useEffect(() => {
    void checkExternalSettingsEdit();
    const onFocus = (): void => {
      void checkExternalSettingsEdit();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [checkExternalSettingsEdit]);

  // `drainErrors` are surfaced as toasts, once per distinct message set.
  const shownErrors = useRef("");
  useEffect(() => {
    const signature = settingsErrors.map((entry) => `${entry.scope}:${entry.message}`).join("|");
    if (signature.length === 0 || signature === shownErrors.current) return;
    shownErrors.current = signature;
    for (const entry of settingsErrors) toast.error(`${entry.scope} settings: ${entry.message}`);
  }, [settingsErrors]);

  const scopes = settings ?? { global: {}, project: {} };
  const defaults = useMemo(() => settingsDefaultsDocument(), []);
  const groups = useMemo(() => groupSettingsFields(), []);

  const openRaw = (scope: SettingsScope): void => {
    setRawScope(scope);
    setRawDraft(JSON.stringify(scopes[scope] ?? {}, null, 2));
    setRawError(null);
    setRawOpen(true);
  };

  const selectRawScope = (scope: SettingsScope): void => {
    setRawScope(scope);
    setRawDraft(JSON.stringify(scopes[scope] ?? {}, null, 2));
    setRawError(null);
  };

  const applyRaw = async (): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = rawDraft.trim().length === 0 ? {} : JSON.parse(rawDraft);
    } catch (error) {
      setRawError(error instanceof Error ? error.message : "invalid JSON");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setRawError("a settings scope must be a JSON object");
      return;
    }
    setRawError(null);
    const ok = await writeRawSettings(rawScope, parsed as Record<string, unknown>);
    if (ok) setRawOpen(false);
    else setRawError("Could not save; see the banner above.");
  };

  const rawDiff = useMemo(() => {
    try {
      const parsed = rawDraft.trim().length === 0 ? {} : JSON.parse(rawDraft);
      return settingsChangesFromDefaults(parsed);
    } catch {
      return [];
    }
  }, [rawDraft]);

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-5 overflow-y-auto px-8 py-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Settings</h1>
          <p className="text-sm text-ink-muted">
            App preferences live in the app's own state file; Pi settings are the shared profile's{" "}
            <code className="font-mono text-xs">settings.json</code>, so terminal Pi sees the same
            values.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setShowAdvanced((value) => !value)}>
            {showAdvanced ? "Hide advanced" : "Show advanced"}
          </Button>
          <Button size="sm" onClick={() => openRaw("global")}>
            Raw JSON…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={settingsBusy}
            onClick={() => void reloadSettings()}
          >
            Reload
          </Button>
        </div>
      </header>

      {settingsExternalEdit ? (
        <div className="banner banner--warn flex items-center justify-between gap-3" role="status">
          <span className="text-xs">
            settings.json changed on disk (terminal Pi or another tool). Reload to see the new
            values; unsaved drafts in this view will be replaced.
          </span>
          <Button size="sm" onClick={() => void reloadSettings()}>
            Reload from disk
          </Button>
        </div>
      ) : null}

      {settingsError ? (
        <p className="banner banner--error text-xs" role="alert">
          {settingsError}
        </p>
      ) : null}

      {!project ? (
        <p className="banner banner--info text-xs">
          No project is open, so project-scope settings are not shown. Global settings still apply
          everywhere.
        </p>
      ) : null}

      {project ? (
        <section
          className="card flex items-center justify-between gap-3"
          data-testid="settings-project-trust"
        >
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Project trust</h2>
            <p className="truncate text-xs text-ink-muted" title={project.path}>
              {project.path}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone={settingsProjectTrusted ? "ok" : "warn"}>
              {settingsProjectTrusted ? "trusted" : "not trusted"}
            </Badge>
            <Button size="sm" onClick={() => void openTrustPrompt(project.path)}>
              Review trust…
            </Button>
          </div>
        </section>
      ) : null}

      <section className="card flex flex-col gap-4" data-testid="app-preferences">
        <h2 className="text-sm font-semibold">App preferences</h2>
        <Row
          label="Theme"
          hint="Applies to the app chrome; step 15 also drives the extension surface."
        >
          <Segmented
            options={THEMES}
            value={prefs.theme}
            onChange={(theme) => setPrefs({ theme })}
          />
        </Row>
        <Row label="Tool-call detail" hint="How much of each tool call the transcript shows.">
          <Segmented
            options={VIEW_MODES}
            value={prefs.viewMode}
            onChange={(viewMode) => setPrefs({ viewMode })}
          />
        </Row>
        <Row label="Sidebar" hint="Width is stored per app.">
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={toggleSidebar}>
              {prefs.sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={prefs.sidebarWidth <= 200}
              onClick={() => setPrefs({ sidebarWidth: Math.max(200, prefs.sidebarWidth - 24) })}
            >
              Narrower
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={prefs.sidebarWidth >= 520}
              onClick={() => setPrefs({ sidebarWidth: Math.min(520, prefs.sidebarWidth + 24) })}
            >
              Wider
            </Button>
            <span className="text-xs text-ink-faint">{prefs.sidebarWidth}px</span>
          </div>
        </Row>
      </section>

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Pi settings</h2>
        <div className="flex items-center gap-2">
          {settingsBusy ? <span className="text-xs text-ink-faint">Saving…</span> : null}
          <Button size="sm" variant="danger" onClick={() => setConfirmReset("global")}>
            Reset to defaults…
          </Button>
        </div>
      </div>

      {!settingsLoaded ? (
        <p className="text-xs text-ink-faint">Reading settings from the Pi profile…</p>
      ) : null}

      {groups.map(({ group, fields }) => {
        const { basic, advanced } = splitAdvancedFields(fields);
        const visible = showAdvanced ? [...basic, ...advanced] : basic;
        if (visible.length === 0) return null;
        return (
          <section
            key={group.id}
            className="card flex flex-col gap-1"
            data-testid={`settings-group-${group.id}`}
          >
            <div>
              <h3 className="text-sm font-semibold">{group.label}</h3>
              <p className="text-xs text-ink-muted">{group.description}</p>
            </div>
            <Separator />
            {visible.map((field: SettingsField) => (
              <SettingsFieldEditor
                key={field.key}
                field={field}
                scopes={scopes}
                provenance={settingsValueProvenance(field, scopes, defaults)}
                projectPath={project?.path ?? null}
                projectTrusted={settingsProjectTrusted}
                busy={settingsBusy}
                onSave={(key, value, scope) => setSetting(key, value, scope)}
                onReset={(key, scope) => resetSetting(key, scope)}
              />
            ))}
          </section>
        );
      })}

      <section className="card flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Profile</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-ink-faint">Profile</dt>
          <dd className="truncate" title={info?.profileDir}>
            {info?.profileDir ?? "unavailable"}
          </dd>
          <dt className="text-ink-faint">settings.json</dt>
          <dd className="truncate" title={info?.settingsFile}>
            {info?.settingsFile ?? "unavailable"}
          </dd>
          <dt className="text-ink-faint">auth.json</dt>
          <dd className="truncate" title={info?.authFile}>
            {info?.authFile ?? "unavailable"}
          </dd>
        </dl>
      </section>

      <Dialog open={rawOpen} onOpenChange={setRawOpen}>
        <DialogContent data-testid="settings-raw-dialog">
          <DialogTitle>Raw settings JSON</DialogTitle>
          <DialogDescription>
            The whole scope document. Keys Pi does not document are preserved; a malformed file is
            never overwritten. Copy the text to export, paste to import.
          </DialogDescription>
          <div className="flex flex-col gap-3 px-4 pb-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex gap-1" role="group" aria-label="Raw settings scope">
                {(["global", "project"] as const).map((scope) => (
                  <Button
                    key={scope}
                    size="sm"
                    variant={scope === rawScope ? "secondary" : "ghost"}
                    aria-pressed={scope === rawScope}
                    disabled={scope === "project" && !project}
                    onClick={() => selectRawScope(scope)}
                  >
                    {scope === "global" ? "Global" : "Project"}
                  </Button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const text = JSON.stringify(scopes[rawScope] ?? {}, null, 2);
                    setRawDraft(text);
                    setRawError(null);
                    void navigator.clipboard?.writeText(text);
                    toast.success("Copied to the clipboard");
                  }}
                >
                  Copy
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    try {
                      setRawDraft(JSON.stringify(JSON.parse(rawDraft), null, 2));
                      setRawError(null);
                    } catch (error) {
                      setRawError(error instanceof Error ? error.message : "invalid JSON");
                    }
                  }}
                >
                  Format
                </Button>
                <Button size="sm" variant="danger" onClick={() => setConfirmReset(rawScope)}>
                  Reset…
                </Button>
              </div>
            </div>
            <textarea
              aria-label="Raw settings JSON"
              data-testid="settings-raw-textarea"
              className="min-h-64 w-full resize-y rounded-sm border border-line bg-sunken p-2 font-mono text-xs text-ink outline-none focus:border-accent"
              value={rawDraft}
              spellCheck={false}
              onChange={(event) => {
                setRawDraft(event.target.value);
                setRawError(null);
              }}
            />
            {rawError ? (
              <p className="text-xs text-danger" role="alert">
                {rawError}
              </p>
            ) : null}
            {rawDiff.length > 0 ? (
              <div className="max-h-40 overflow-y-auto rounded-sm border border-line p-2">
                <p className="mb-1 text-xs text-ink-muted">Differs from defaults:</p>
                <ul className="flex flex-col gap-0.5 font-mono text-[11px]">
                  {rawDiff.map((entry) => (
                    <li key={entry.key} className="flex justify-between gap-3">
                      <span className="text-ink-muted">{entry.key}</span>
                      <span className="text-ink">
                        {describeSettingsValue(entry.value)}{" "}
                        <span className="text-ink-faint">
                          (was {describeSettingsValue(entry.defaultValue)})
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setRawOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={settingsBusy} onClick={() => void applyRaw()}>
                Apply
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmReset !== null} onOpenChange={(open) => !open && setConfirmReset(null)}>
        <DialogContent data-testid="settings-reset-dialog">
          <DialogTitle>
            Reset {confirmReset === "project" ? "project" : "global"} settings?
          </DialogTitle>
          <DialogDescription>
            {confirmReset === "project"
              ? "Removes every project override. Pi falls back to the global values and defaults."
              : "Writes Pi's documented defaults for this profile. A backup of the previous file is kept in the app's backups folder."}
          </DialogDescription>
          <div className="flex items-center justify-end gap-2 px-4 pb-4">
            <Button size="sm" variant="ghost" onClick={() => setConfirmReset(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={settingsBusy}
              onClick={() => {
                const scope = confirmReset;
                setConfirmReset(null);
                if (scope) void resetScope(scope);
              }}
            >
              Reset
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-sm">{label}</div>
      {hint ? <div className="text-xs text-ink-faint">{hint}</div> : null}
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex gap-1">
      {options.map((option) => (
        <Button
          key={option}
          size="sm"
          variant={option === value ? "secondary" : "ghost"}
          aria-pressed={option === value}
          onClick={() => onChange(option)}
        >
          {option}
        </Button>
      ))}
    </div>
  );
}
