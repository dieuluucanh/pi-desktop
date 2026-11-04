/**
 * The active theme's chrome colour editor (2026-10-31 theme plan).
 *
 * The theme card used to show inert swatches; a click only selected the theme.
 * The active card now renders real `<input type="color">` controls for the app
 * chrome tokens, including the separator colours the high-contrast dark theme
 * is built around. Values are stored as app preferences (per theme), never in a
 * Pi theme file; Reset removes that theme's overrides.
 */

import {
  resolvedChromeSwatches,
  type ThemeColorKey,
  type ThemeColorOverrides,
  type ThemeSummary,
} from "../../../shared/themes";
import { Button } from "../ui/button";

const FIELDS: ReadonlyArray<{ key: ThemeColorKey; label: string }> = [
  { key: "canvas", label: "Canvas" },
  { key: "surface", label: "Surface" },
  { key: "raised", label: "Raised surface" },
  { key: "sunken", label: "Sunken surface" },
  { key: "line", label: "Separator" },
  { key: "lineStrong", label: "Strong separator" },
  { key: "ink", label: "Text" },
  { key: "inkMuted", label: "Muted text" },
  { key: "inkFaint", label: "Faint text" },
  { key: "accent", label: "Accent" },
  { key: "info", label: "Info" },
  { key: "ok", label: "Success" },
  { key: "warn", label: "Warning" },
  { key: "danger", label: "Error" },
];

export interface ThemeColorEditorProps {
  theme: ThemeSummary;
  overrides: ThemeColorOverrides;
  onChange: (key: ThemeColorKey, value: string) => void;
  onReset: () => void;
  disabled?: boolean;
}

export function ThemeColorEditor({
  theme,
  overrides,
  onChange,
  onReset,
  disabled = false,
}: ThemeColorEditorProps) {
  const colors = resolvedChromeSwatches(theme, overrides);
  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <div className="flex flex-col gap-2" data-testid="theme-colors">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-ink">Chrome colours</span>
        <Button
          size="sm"
          variant="ghost"
          data-testid="theme-colors-reset"
          disabled={disabled || !hasOverrides}
          onClick={onReset}
        >
          Reset colours
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {FIELDS.map(({ key, label }) => (
          <label
            key={key}
            className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-ink-muted"
            title={`${label} ${colors[key]}`}
          >
            <span className="min-w-0 truncate">{label}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              <span className="font-mono text-[10px] text-ink-faint">{colors[key]}</span>
              <input
                type="color"
                value={colors[key]}
                disabled={disabled}
                aria-label={`${label} color`}
                data-testid={`theme-color-${key}`}
                onChange={(event) => onChange(key, event.target.value)}
                className="size-5 cursor-pointer rounded-xs border border-line bg-transparent p-0 disabled:opacity-50"
              />
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
