import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";

/**
 * Theme catalogue (plan step 15).
 *
 * Built-ins plus every theme file Pi's loader reports, with preview swatches
 * resolved by the host, the active theme marked, and a `.json` import that
 * validates before anything is written (the host refuses a mismatched name, a
 * partial document or a non-`<name>.json` filename). Activating a theme writes
 * the `theme` setting and recolours the app chrome from its swatches.
 */
export function ThemesSection() {
  const themes = useAppStore((state) => state.themes);
  const themesLoaded = useAppStore((state) => state.themesLoaded);
  const themesBusy = useAppStore((state) => state.themesBusy);
  const themesError = useAppStore((state) => state.themesError);
  const loadThemes = useAppStore((state) => state.loadThemes);
  const setActiveTheme = useAppStore((state) => state.setActiveTheme);
  const importTheme = useAppStore((state) => state.importTheme);
  const [activating, setActivating] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void loadThemes();
  }, [loadThemes]);

  const onImportFile = async (file: File): Promise<void> => {
    const content = await file.text();
    await importTheme(file.name, content);
  };

  return (
    <section className="card flex flex-col gap-2" data-testid="themes">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Themes</h2>
          <p className="text-xs text-ink-muted">
            The active Pi theme drives the app chrome. Custom themes are{" "}
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
      {themesError ? (
        <p className="banner banner--error text-xs" role="alert">
          {themesError}
        </p>
      ) : null}
      {!themesLoaded ? (
        <p className="text-xs text-ink-faint">Reading themes from Pi…</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {themes.themes.map((theme) => (
            <li
              key={`${theme.scope}:${theme.name}`}
              className="flex items-center justify-between gap-3 rounded-sm border border-line px-3 py-2"
            >
              <div className="flex min-w-0 flex-col gap-1">
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
              </div>
              {!theme.active ? (
                <Button
                  size="sm"
                  disabled={themesBusy || activating !== null}
                  onClick={() => {
                    setActivating(theme.name);
                    void setActiveTheme(theme.name).finally(() => setActivating(null));
                  }}
                >
                  {activating === theme.name ? "Applying…" : "Use"}
                </Button>
              ) : null}
            </li>
          ))}
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
