/**
 * Themes shared model (plan step 15).
 *
 * Pi themes are JSON documents (`{name, vars?, colors}`) living in
 * `<agentDir>/themes`, `<project>/.pi/themes`, or the `themes` settings array,
 * plus the built-ins `dark` and `light`. The host parses file documents and
 * resolves their colour names through `vars`; the built-ins' swatches are a
 * checked-in copy (resolved from the SDK's own theme JSON) pinned by a drift
 * test, because the SDK's `exports` map blocks deep imports.
 *
 * Everything here is pure: no SDK import, no DOM, no filesystem.
 */

/** Where a theme came from. */
export const THEME_SCOPES = ["builtin", "user", "project"] as const;
export type ThemeScope = (typeof THEME_SCOPES)[number];

export function isThemeScope(value: unknown): value is ThemeScope {
  return typeof value === "string" && (THEME_SCOPES as readonly string[]).includes(value);
}

/** One theme in the catalogue. Swatches are resolved `#rrggbb` hex strings. */
export interface ThemeSummary {
  name: string;
  scope: ThemeScope;
  /** Absolute file path for file-based themes; absent for built-ins. */
  path?: string;
  active: boolean;
  variant: "dark" | "light";
  swatches: Record<string, string>;
}

/** The whole catalogue as the renderer consumes it. */
export interface ThemesSnapshot {
  /** The active Pi theme name (the `theme` settings key). */
  active: string;
  themes: ThemeSummary[];
}

export const EMPTY_THEMES: ThemesSnapshot = { active: "dark", themes: [] };

/** Swatch keys the app chrome maps to its own tokens. */
export const THEME_SWATCH_KEYS = [
  "accent",
  "text",
  "muted",
  "dim",
  "success",
  "error",
  "warning",
  "canvas",
  "surface",
] as const;
export type ThemeSwatchKey = (typeof THEME_SWATCH_KEYS)[number];

/**
 * The chrome colours a theme/override can set. `THEME_SWATCH_KEYS` describes
 * what a Pi theme document supplies; these are the app's own tokens, including
 * the neutral infrastructure (`raised`, `sunken`, `line`, `lineStrong`) that Pi
 * themes do not map directly.
 */
export const THEME_COLOR_KEYS = [
  "canvas",
  "surface",
  "raised",
  "sunken",
  "line",
  "lineStrong",
  "ink",
  "inkMuted",
  "inkFaint",
  "accent",
  "info",
  "ok",
  "warn",
  "danger",
] as const;
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];
export type ThemeColorOverrides = Partial<Record<ThemeColorKey, string>>;

/**
 * The app-owned chrome palette (2026-10-31 high-contrast pass). Dark is a
 * deliberate high-contrast neutral palette: `line`/`lineStrong` are tuned to be
 * visible against `surface` (see `contrastRatio` in the tests) while built-in
 * themes keep their own accent/status identity. Light mirrors `tokens.css`.
 */
export const APP_CHROME_SWATCHES: Record<"dark" | "light", Record<ThemeColorKey, string>> = {
  dark: {
    canvas: "#0b0d12",
    surface: "#141922",
    raised: "#232b39",
    sunken: "#080a0e",
    line: "#4e5b79",
    lineStrong: "#6b7a99",
    ink: "#eef2f8",
    inkMuted: "#aab4c6",
    inkFaint: "#7f8ba0",
    accent: "#7aa2f7",
    info: "#7dcfff",
    ok: "#9ece6a",
    warn: "#e0af68",
    danger: "#f7768e",
  },
  light: {
    canvas: "#f6f7f9",
    surface: "#ffffff",
    raised: "#ffffff",
    sunken: "#eceef2",
    line: "#dcdfe6",
    lineStrong: "#c3c8d4",
    ink: "#1c2128",
    inkMuted: "#5b6472",
    inkFaint: "#8b94a3",
    accent: "#3b6fd4",
    info: "#16689b",
    ok: "#3f7d2c",
    warn: "#9a6700",
    danger: "#c33c54",
  },
};

/**
 * Built-in swatches, resolved from the SDK's own theme JSON (`vars` + `export`
 * sections) at `@earendil-works/pi-coding-agent@1.4.0`. `tests/shared/themes`
 * re-resolves the SDK files and asserts equality, so an upstream palette change
 * turns into a failing test instead of a stale preview.
 */
export const BUILTIN_THEME_SWATCHES: Record<string, Record<ThemeSwatchKey, string>> = {
  dark: {
    accent: "#a798d7",
    text: "#dee0e1",
    muted: "#9da5a9",
    dim: "#7e888e",
    success: "#68b78d",
    error: "#ea7f81",
    warning: "#cd9a22",
    canvas: "#21252c",
    surface: "#282c34",
  },
  light: {
    accent: "#7459b4",
    text: "#3b3f41",
    muted: "#677176",
    dim: "#879095",
    success: "#337e58",
    error: "#c8253d",
    warning: "#8f6802",
    canvas: "#efeeee",
    surface: "#f7f6f6",
  },
};

export const BUILTIN_THEME_NAMES = Object.keys(BUILTIN_THEME_SWATCHES);

/** Required `colors` keys, from Pi's theme JSON schema. */
export const REQUIRED_THEME_COLORS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "selectedBg",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
] as const;

export type ThemeColorValue = string | number;

export interface ParsedThemeDocument {
  name: string;
  vars: Record<string, string>;
  colors: Record<string, ThemeColorValue>;
}

export class ThemeDocumentError extends Error {
  readonly code: string;

  constructor(message: string, code = "bad_theme") {
    super(message);
    this.name = "ThemeDocumentError";
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Parses and validates a theme JSON document: it must be an object with a
 * non-empty `name` and a `colors` object carrying every required key, each a
 * `#rrggbb` string, a colour name resolvable through `vars`, or an ANSI 256
 * palette index.
 */
export function parseThemeDocument(text: string): ParsedThemeDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ThemeDocumentError("theme file is not valid JSON");
  }
  const document = asRecord(parsed);
  if (Array.isArray(parsed) || Object.keys(document).length === 0) {
    throw new ThemeDocumentError("theme file must be a JSON object");
  }
  const name = document.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ThemeDocumentError('theme file must declare a non-empty "name"');
  }
  const colors = asRecord(document.colors);
  const exported = asRecord(document.export);
  const missing = REQUIRED_THEME_COLORS.filter((key) => colors[key] === undefined);
  if (missing.length > 0) {
    throw new ThemeDocumentError(`theme "${name}" is missing colors: ${missing.join(", ")}`);
  }
  const bad = REQUIRED_THEME_COLORS.filter(
    (key) =>
      typeof colors[key] !== "string" ||
      ((colors[key] as string).trim().length === 0 && typeof colors[key] !== "number"),
  ).filter((key) => typeof colors[key] !== "number" && typeof colors[key] !== "string");
  if (bad.length > 0) {
    throw new ThemeDocumentError(
      `theme "${name}" has non-string colors: ${bad.join(", ")} (use "#rrggbb" or a palette index)`,
    );
  }
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(document.vars))) {
    if (typeof value === "string" && value.trim().length > 0) vars[key] = value.trim();
  }
  const colorEntries: Record<string, ThemeColorValue> = {};
  for (const [key, value] of Object.entries(colors)) {
    if (typeof value === "string" || typeof value === "number") colorEntries[key] = value;
  }
  // Pi 1.4 moved the chrome-only colours (`pageBg`, `cardBg`, `infoBg`) into an
  // `export` object. Merge them so the preview resolver sees them.
  for (const [key, value] of Object.entries(exported)) {
    if (
      colorEntries[key] === undefined &&
      (typeof value === "string" || typeof value === "number")
    ) {
      colorEntries[key] = value;
    }
  }
  return { name: name.trim(), vars, colors: colorEntries };
}

/** Standard xterm 256-colour ramp, for integer colour values in theme files. */
export function ansi256ToHex(index: number): string {
  const clamped = Math.max(0, Math.min(255, Math.floor(index)));
  if (clamped < 16) {
    const base = [
      "#000000",
      "#800000",
      "#008000",
      "#808000",
      "#000080",
      "#800080",
      "#008080",
      "#c0c0c0",
      "#808080",
      "#ff0000",
      "#00ff00",
      "#ffff00",
      "#0000ff",
      "#ff00ff",
      "#00ffff",
      "#ffffff",
    ];
    return base[clamped] ?? "#000000";
  }
  if (clamped < 232) {
    const slot = clamped - 16;
    const levels = ["00", "5f", "87", "af", "d7", "ff"];
    const r = levels[Math.floor(slot / 36)] ?? "00";
    const g = levels[Math.floor((slot % 36) / 6)] ?? "00";
    const b = levels[slot % 6] ?? "00";
    return `#${r}${g}${b}`;
  }
  const gray = (8 + (clamped - 232) * 10).toString(16).padStart(2, "0");
  return `#${gray}${gray}${gray}`;
}

/** Resolves one colour value to hex: `#rrggbb` as-is, an index via the ramp. */
export function resolveThemeColor(
  value: ThemeColorValue,
  vars: Record<string, string>,
): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? ansi256ToHex(value) : null;
  }
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return `#${trimmed.slice(1).toLowerCase()}`;
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [r, g, b] = [trimmed[1], trimmed[2], trimmed[3]];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const viaVars = vars[trimmed];
  if (typeof viaVars === "string" && /^#[0-9a-fA-F]{3,6}$/.test(viaVars.trim())) {
    return resolveThemeColor(viaVars.trim(), {});
  }
  return null;
}

function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const linear = (channel: number): number =>
    channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * Dark or light from the resolved `text` colour: light text means the theme is
 * designed for a dark chrome, and vice versa. Falls back to dark when the text
 * colour is unknown.
 */
export function themeVariantFromText(textHex: string | null): "dark" | "light" {
  if (!textHex) return "dark";
  return luminance(textHex) >= 0.25 ? "dark" : "light";
}

/**
 * Resolves the app swatch map from a parsed document: named colours go through
 * `vars`, `canvas`/`surface` fall back to the text-luminance variant defaults.
 */
export type ThemeColorResolver = (
  value: ThemeColorValue,
  vars: Record<string, string>,
) => string | null;

/**
 * Resolves the app swatch map from a parsed document: named colours go through
 * `vars`, `canvas`/`surface` fall back to the text-luminance variant defaults.
 * The optional resolver lets the host handle Pi's `okhsl(...)`/`oklch(...)`
 * values without pulling the SDK into the renderer.
 */
export function resolveThemeSwatches(
  document: ParsedThemeDocument,
  resolveColor: ThemeColorResolver = resolveThemeColor,
): Record<ThemeSwatchKey, string> {
  const pick = (key: string): string | null => {
    const value = document.colors[key];
    return value === undefined ? null : resolveColor(value, document.vars);
  };
  const text = pick("text");
  const variant = themeVariantFromText(text);
  const fallback = BUILTIN_THEME_SWATCHES[variant] ?? BUILTIN_THEME_SWATCHES.dark;
  const resolved = (key: string, fallbackKey: ThemeSwatchKey): string =>
    pick(key) ?? (fallback as Record<string, string>)[fallbackKey] ?? "#888888";
  return {
    accent: resolved("accent", "accent"),
    text: text ?? (fallback as Record<string, string>).text ?? "#d4d4d4",
    muted: resolved("muted", "muted"),
    dim: resolved("dim", "dim"),
    success: resolved("success", "success"),
    error: resolved("error", "error"),
    warning: resolved("warning", "warning"),
    canvas: resolved("pageBg", "canvas"),
    surface: resolved("cardBg", "surface"),
  };
}

/**
 * The chrome variables a theme can set. `applyChromeTheme` clears all of them
 * before applying a new theme, so a key a custom theme set cannot survive a
 * switch to a theme that omits it.
 */
export const THEME_CHROME_VARIABLES = [
  "--color-canvas",
  "--color-surface",
  "--color-raised",
  "--color-sunken",
  "--color-line",
  "--color-line-strong",
  "--color-ink",
  "--color-ink-muted",
  "--color-ink-faint",
  "--color-accent",
  "--color-info",
  "--color-ok",
  "--color-warn",
  "--color-danger",
] as const;

export type ThemeChromeSource = Pick<ThemeSummary, "scope" | "variant" | "swatches">;

/**
 * Resolves the chrome colours for a theme.
 *
 * Built-in themes use the app's neutral high-contrast palette for surfaces and
 * ink (Pi's built-in dark surface made separators nearly invisible), while
 * keeping the theme's accent/status identity. Custom themes keep their own
 * canvas/surface/text/muted/dim and use the app's infrastructure colours.
 * User overrides win last.
 */
export function resolvedChromeSwatches(
  theme: ThemeChromeSource,
  overrides: ThemeColorOverrides = {},
): Record<ThemeColorKey, string> {
  const app = APP_CHROME_SWATCHES[theme.variant];
  const builtin = theme.scope === "builtin";
  const swatches = theme.swatches;
  const resolved: Record<ThemeColorKey, string> = {
    canvas: builtin ? app.canvas : (swatches.canvas ?? app.canvas),
    surface: builtin ? app.surface : (swatches.surface ?? app.surface),
    raised: app.raised,
    sunken: app.sunken,
    line: app.line,
    lineStrong: app.lineStrong,
    ink: builtin ? app.ink : (swatches.text ?? app.ink),
    inkMuted: builtin ? app.inkMuted : (swatches.muted ?? app.inkMuted),
    inkFaint: builtin ? app.inkFaint : (swatches.dim ?? app.inkFaint),
    accent: swatches.accent ?? app.accent,
    info: app.info,
    ok: swatches.success ?? app.ok,
    warn: swatches.warning ?? app.warn,
    danger: swatches.error ?? app.danger,
  };
  for (const key of THEME_COLOR_KEYS) {
    const value = overrides[key];
    if (value) resolved[key] = value;
  }
  return resolved;
}

/**
 * Maps a theme (plus optional user overrides) onto the app chrome's CSS
 * variables. The renderer sets these on `document.documentElement`, so no
 * component knows a hex value.
 */
export function themeCssVariables(
  theme: ThemeChromeSource,
  overrides: ThemeColorOverrides = {},
): Record<string, string> {
  const colors = resolvedChromeSwatches(theme, overrides);
  return {
    "data-theme": theme.variant,
    "--color-canvas": colors.canvas,
    "--color-surface": colors.surface,
    "--color-raised": colors.raised,
    "--color-sunken": colors.sunken,
    "--color-line": colors.line,
    "--color-line-strong": colors.lineStrong,
    "--color-ink": colors.ink,
    "--color-ink-muted": colors.inkMuted,
    "--color-ink-faint": colors.inkFaint,
    "--color-accent": colors.accent,
    "--color-info": colors.info,
    "--color-ok": colors.ok,
    "--color-warn": colors.warn,
    "--color-danger": colors.danger,
  };
}

/** WCAG relative-luminance contrast ratio for two `#rrggbb` colours. */
export function contrastRatio(hexA: string, hexB: string): number {
  const luminance = (hex: string): number => {
    const value = hex.replace("#", "");
    const channels = [0, 2, 4].map((offset) => {
      const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
  };
  const a = luminance(hexA);
  const b = luminance(hexB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Per-theme colour overrides, keyed by the theme name. */
export type ThemeColorPrefs = Record<string, ThemeColorOverrides>;

export const MAX_THEME_COLOR_THEMES = 32;
export const MAX_THEME_COLOR_NAME_LENGTH = 64;

/** Normalizes one `#rrggbb` value; anything else is rejected. */
export function normalizeThemeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** Drops unknown keys and malformed colours from one theme's overrides. */
export function sanitizeThemeColorOverrides(value: unknown): ThemeColorOverrides {
  const record = asRecord(value);
  const overrides: ThemeColorOverrides = {};
  for (const key of THEME_COLOR_KEYS) {
    const color = normalizeThemeColor(record[key]);
    if (color) overrides[key] = color;
  }
  return overrides;
}

/** Bounds the override map so `app-state.json` cannot grow without limit. */
export function sanitizeThemeColorPrefs(value: unknown): ThemeColorPrefs {
  const record = asRecord(value);
  const result: ThemeColorPrefs = {};
  let count = 0;
  for (const [name, entry] of Object.entries(record)) {
    if (count >= MAX_THEME_COLOR_THEMES) break;
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_THEME_COLOR_NAME_LENGTH) continue;
    const overrides = sanitizeThemeColorOverrides(entry);
    if (Object.keys(overrides).length === 0) continue;
    result[trimmed] = overrides;
    count += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sanitizers — the renderer never trusts a raw host payload.
// ---------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asSwatches(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const swatches: Record<string, string> = {};
  for (const key of THEME_SWATCH_KEYS) {
    const entry = record[key];
    if (typeof entry === "string" && /^#[0-9a-f]{6}$/.test(entry)) swatches[key] = entry;
  }
  return swatches;
}

export function sanitizeThemeSummary(value: unknown): ThemeSummary | null {
  const record = asRecord(value);
  const name = asString(record.name);
  if (!name) return null;
  const scope = isThemeScope(record.scope) ? record.scope : "user";
  const path = asString(record.path);
  const variant = record.variant === "light" ? "light" : "dark";
  return {
    name,
    scope,
    ...(path ? { path } : {}),
    active: record.active === true,
    variant,
    swatches: asSwatches(record.swatches),
  };
}

export function sanitizeThemesSnapshot(value: unknown): ThemesSnapshot {
  const record = asRecord(value);
  const themes = Array.isArray(record.themes)
    ? record.themes
        .map(sanitizeThemeSummary)
        .filter((entry): entry is ThemeSummary => entry !== null)
    : [];
  return { active: asString(record.active) ?? "dark", themes };
}

/** Finds the active theme's swatches for the chrome, if the catalogue has them. */
export function activeThemeSwatches(snapshot: ThemesSnapshot): ThemeSummary | undefined {
  return (
    snapshot.themes.find((theme) => theme.name === snapshot.active) ??
    snapshot.themes.find((theme) => theme.active)
  );
}
