import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { SettingsScope } from "../../../shared/settings-schema";
import { formatZoomPercent } from "../../../shared/zoom";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "../../../shared/prefs";
import {
  getSettingsValue,
  groupSettingsFields,
  settingsChangesFromDefaults,
  settingsDefaultsDocument,
  type SettingsField,
} from "../../../shared/settings-schema";
import {
  describeSettingsValue,
  settingsGlobalValueProvenance,
  splitAdvancedFields,
} from "../../../shared/settings-view";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";
import { SettingsFieldEditor } from "../settings/SettingsFieldEditor";
import {
  CheckpointsSettingsCard,
  SourceControlSettingsCard,
} from "../settings/SourceControlSettings";
import { NotificationsSettingsCard } from "../settings/NotificationsSettings";
import { TerminalSettingsCard } from "../settings/TerminalSettings";
import { setSidebarWidth } from "../state/sidebar-width";
import { ViewShell } from "./ViewShell";

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

/**
 * Settings fields this view does not render because another surface owns them.
 * `theme` is the Pi theme setting; the Skills → Themes catalogue is its one
 * control (the raw JSON editor remains an escape hatch).
 */
const APP_OWNED_SETTINGS = new Set(["theme"]);

export function SettingsView() {
  const prefs = useAppStore((state) => state.prefs);
  const setPrefs = useAppStore((state) => state.setPrefs);
  const setView = useAppStore((state) => state.setView);
  const zoomFactor = useAppStore((state) => state.prefs.zoomFactor);
  const zoomIn = useAppStore((state) => state.zoomIn);
  const zoomOut = useAppStore((state) => state.zoomOut);
  const zoomReset = useAppStore((state) => state.zoomReset);
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
  const settingsFocus = useAppStore((state) => state.settingsFocus);
  const clearSettingsFocus = useAppStore((state) => state.clearSettingsFocus);
  const terminalCardRef = useRef<HTMLDivElement | null>(null);
  const notificationsCardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // The Help menu and the terminal profile menu route here: scroll to the
    // target card, then consume it so a later Settings visit starts at the top.
    if (!settingsFocus) return;
    const target =
      settingsFocus === "notifications" ? notificationsCardRef.current : terminalCardRef.current;
    target?.scrollIntoView?.({ block: "start" });
    clearSettingsFocus();
  }, [settingsFocus, clearSettingsFocus]);
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
    <ViewShell width="standard" gap={5}>
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
          Settings are shared globally. Project overrides are managed from the project panel.
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
          hint="Light, dark and custom themes live in Skills, themes & keys — one catalogue, one control."
        >
          <Button size="sm" onClick={() => setView("skills")}>
            Open theme settings
          </Button>
        </Row>
        <Row
          label="Display zoom"
          hint="Changes the size of the whole app. View → Zoom In / Zoom Out / Actual Size, or Ctrl/Cmd + = / - / 0."
        >
          <div className="flex items-center gap-2" data-testid="display-zoom">
            <Button size="sm" variant="ghost" aria-label="Zoom out" onClick={zoomOut}>
              −
            </Button>
            <Button size="sm" variant="ghost" title="Reset to 100%" onClick={zoomReset}>
              {formatZoomPercent(zoomFactor)}
            </Button>
            <Button size="sm" variant="ghost" aria-label="Zoom in" onClick={zoomIn}>
              +
            </Button>
          </div>
        </Row>
        <Row
          label="Background dialogs"
          hint="An extension in another tab can ask a question while you work here. Blocking: only a question that waits for you takes the window, and never while you type or a run is streaming; otherwise the tab shows a dot. Never: only the dot."
        >
          <div className="flex items-center gap-2" data-testid="dialog-focus-policy">
            <Switch
              checked={prefs.dialogs.autoFocus === "blocking"}
              onCheckedChange={(blocking) =>
                setPrefs({ dialogs: { autoFocus: blocking ? "blocking" : "never" } })
              }
              aria-label="Let a blocking background dialog take the window"
            />
            <span className="text-xs text-ink-faint">
              {prefs.dialogs.autoFocus === "blocking" ? "blocking only" : "never switch"}
            </span>
          </div>
        </Row>
        <Row
          label="Expanded command prompts"
          hint="Commands such as /commit send a long instruction to the model. Off: the transcript names the command you sent and hides the instruction; Ctrl+O or the row's Show button reveals it."
        >
          <div className="flex items-center gap-2" data-testid="expanded-command-prompts">
            <Switch
              checked={prefs.showExpandedPrompts}
              onCheckedChange={(showExpandedPrompts) => setPrefs({ showExpandedPrompts })}
              aria-label="Show expanded command prompts"
            />
            <span className="text-xs text-ink-faint">
              {prefs.showExpandedPrompts ? "show by default" : "collapsed (default)"}
            </span>
          </div>
        </Row>
        <Row label="Sidebar" hint="Width is stored per app.">
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={toggleSidebar}>
              {prefs.sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={prefs.sidebarWidth <= MIN_SIDEBAR_WIDTH}
              onClick={() => setSidebarWidth(prefs.sidebarWidth - 24)}
            >
              Narrower
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={prefs.sidebarWidth >= MAX_SIDEBAR_WIDTH}
              onClick={() => setSidebarWidth(prefs.sidebarWidth + 24)}
            >
              Wider
            </Button>
            <span className="text-xs text-ink-faint">{prefs.sidebarWidth}px</span>
          </div>
        </Row>
        <Row
          label="Install telemetry"
          hint="Pi's anonymous install/update ping and provider attribution header. Off by default; this app never rewrites Pi's shared settings.json."
        >
          <div className="flex items-center gap-2" data-testid="privacy-telemetry">
            <Switch
              checked={prefs.telemetryEnabled}
              onCheckedChange={(telemetryEnabled) =>
                setPrefs({ telemetryEnabled, privacyAcknowledged: true })
              }
              aria-label="Share anonymous install telemetry"
            />
            <span className="text-xs text-ink-faint">
              {prefs.telemetryEnabled ? "on (new sessions)" : "off"}
            </span>
          </div>
        </Row>
      </section>

      <div ref={terminalCardRef}>
        <TerminalSettingsCard />
      </div>

      {/*
        Source control and checkpoints (git-checkpoint plan step 27). Both cards edit
        `prefs` only: main projects the checkpoint keys to
        `<profile>/checkpoints/config.json`, and the host-side extension reads that
        file — there is no second write path (D19).
      */}
      <SourceControlSettingsCard />
      <CheckpointsSettingsCard />
      <div ref={notificationsCardRef}>
        <NotificationsSettingsCard />
      </div>

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
        const visible = (showAdvanced ? [...basic, ...advanced] : basic).filter(
          (field) => !APP_OWNED_SETTINGS.has(field.key),
        );
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
                provenance={settingsGlobalValueProvenance(field, scopes, defaults)}
                projectOverride={getSettingsValue(scopes.project, field.key) !== undefined}
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
                {(["global"] as const).map((scope) => (
                  <Button
                    key={scope}
                    size="sm"
                    variant={scope === rawScope ? "secondary" : "ghost"}
                    aria-pressed={scope === rawScope}
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
    </ViewShell>
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
