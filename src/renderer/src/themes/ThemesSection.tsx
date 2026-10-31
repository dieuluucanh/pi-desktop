import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";
import { systemThemeName } from "./system-theme";

/**
 * Theme catalogue (plan step 15; single-control pass 2026-10-30).
 *
 * Built-ins plus every theme file Pi's loader reports, with preview swatches
 * resolved by the host, the active theme marked, and a `.json` import that
 * validates before anything is written (the host refuses a mismatched name, a
 * partial document or a non-`<name>.json` filename). Activating a theme writes
 * the `theme` setting and recolours the app chrome from its swatches.
 *
 * The whole card is the control: `role="radio"` on a button, `aria-checked` for
 * the active theme, and the swatches live inside it so clicking a colour selects
 * the theme. There is no second "Use" button beside the preview — that was the
 * "swatch is displayed but not selectable" report.
 */
export function ThemesSection() {
  const themes = useAppStore((state) => state.themes);
  const themesLoaded = useAppStore((state) => state.themesLoaded);
  const themesBusy = useAppStore((state) => state.themesBusy);
  const themesError = useAppStore((state) => state.themesError);
  const loadThemes = useAppStore((state) => state.loadThemes);
  const setActiveTheme = useAppStore((state) => state.setActiveTheme);
  const importTheme = useAppStore((state) => state.importTheme);
  const followSystemTheme = useAppStore((state) => state.prefs.followSystemTheme);
  const setFollowSystemTheme = useAppStore((state) => state.setFollowSystemTheme);
  const [activating, setActivating] = useState<string | null>(null);
  const [activationError, setActivationError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void loadThemes();
  }, [loadThemes]);

  const onImportFile = async (file: File): Promise<void> => {
    const content = await file.text();
    await importTheme(file.name, content);
  };

  const error = activationError ?? themesError;

  return (
    <section className="card flex flex-col gap-2" data-testid="themes">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Themes</h2>
          <p className="text-xs text-ink-muted">
            The active Pi theme drives the app chrome. Click a theme to apply it; custom themes are{" "}
            <code className="font-mono">.json</code> files in the profile or project themes folder.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>
          Import .json
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          aria-label="Import theme file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void onImportFile(file);
          }}
        />
      </div>
      <Separator />
      <div className="flex items-center justify-between gap-3 rounded-sm border border-line px-3 py-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-ink">
            Match system appearance
            {followSystemTheme ? <Badge tone="ok">following {systemThemeName()}</Badge> : null}
          </div>
          <p className="text-xs text-ink-muted">
            Uses the built-in dark or light Pi theme and switches with Windows/macOS. Choosing
            another theme turns this off.
          </p>
        </div>
        <Switch
          checked={followSystemTheme}
          onCheckedChange={setFollowSystemTheme}
          aria-label="Match system appearance"
        />
      </div>
      {error ? (
        <p className="banner banner--error text-xs" role="alert">
          {error}
        </p>
      ) : null}
      {!themesLoaded ? (
        <p className="text-xs text-ink-faint">Reading themes from Pi…</p>
      ) : (
        <ul role="radiogroup" aria-label="Themes" className="flex flex-col gap-2">
          {themes.themes.map((theme) => {
            const key = `${theme.scope}:${theme.name}`;
            const busy = activating === key;
            const disabled = themesBusy || (activating !== null && !busy);
            return (
              <li key={key}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={theme.active}
                  disabled={disabled}
                  data-testid={`theme-${theme.scope}-${theme.name}`}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-sm border px-3 py-2 text-left transition-colors",
                    theme.active
                      ? "border-accent bg-selected/40"
                      : "border-line hover:bg-raised/60",
                    disabled && "opacity-60",
                  )}
                  onClick={() => {
                    if (theme.active || disabled) return;
                    setActivationError(null);
                    setActivating(key);
                    void setActiveTheme(theme.name)
                      .then((ok) => {
                        if (!ok) setActivationError(`Could not apply the ${theme.name} theme.`);
                      })
                      .finally(() => setActivating(null));
                  }}
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-ink">
                      {theme.name}
                      <Badge tone="neutral">{theme.scope}</Badge>
                      <Badge tone="neutral">{theme.variant}</Badge>
                      {theme.active ? <Badge tone="ok">active</Badge> : null}
                      {Object.keys(theme.swatches).length === 0 ? (
                        <Badge tone="warn">no preview</Badge>
                      ) : null}
                    </span>
                    {theme.path ? (
                      <span className="truncate font-mono text-[10px] text-ink-faint">
                        {theme.path}
                      </span>
                    ) : null}
                    <Swatches swatches={theme.swatches} />
                  </span>
                  <span
                    className={cn(
                      "flex shrink-0 items-center gap-1 text-xs",
                      theme.active ? "text-accent" : "text-ink-faint",
                    )}
                  >
                    {theme.active ? (
                      <>
                        <Check className="size-3" aria-hidden />
                        Active
                      </>
                    ) : busy ? (
                      "Applying…"
                    ) : (
                      "Use"
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Swatches({ swatches }: { swatches: Record<string, string> }) {
  const entries = Object.entries(swatches);
  if (entries.length === 0) return null;
  return (
    <span className="flex gap-1" aria-hidden>
      {entries.map(([key, value]) => (
        <span
          key={key}
          title={`${key} ${value}`}
          className="size-4 rounded-xs border border-line"
          style={{ backgroundColor: value }}
        />
      ))}
    </span>
  );
}
