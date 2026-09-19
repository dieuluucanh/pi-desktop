import { Button } from "../ui/button";
import { useAppStore } from "../state/app-store";
import type { ThemeSetting, ViewMode } from "../../../shared/prefs";

/**
 * Settings view (plan step 1).
 *
 * Two clearly separated halves: the app's own preferences (real, persisted now)
 * and Pi's settings, which are read from and written to the shared profile in
 * step 12 through the SDK's `SettingsManager` — never by hand (repo rule 3).
 */

const THEMES: readonly ThemeSetting[] = ["dark", "light", "system"];
const VIEW_MODES: readonly ViewMode[] = ["normal", "verbose", "summary"];

export function SettingsView() {
  const prefs = useAppStore((state) => state.prefs);
  const setPrefs = useAppStore((state) => state.setPrefs);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const info = useAppStore((state) => state.info);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-y-auto px-8 py-6">
      <header>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-sm text-ink-muted">
          App preferences are stored in the app's own state file; Pi settings stay in the shared
          profile so terminal Pi sees the same values.
        </p>
      </header>

      <section className="card flex flex-col gap-4">
        <h2 className="text-sm font-semibold">Appearance</h2>

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

      <section className="card flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Pi settings</h2>
        <p className="text-xs text-ink-muted">
          Every key in Pi's settings.json (model defaults, compaction, retries, shell, tools,
          sessions, markdown, warnings) becomes editable here in step 12, written through the SDK's
          SettingsManager with a backup before the first change.
        </p>
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
