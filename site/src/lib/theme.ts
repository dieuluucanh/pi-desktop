/**
 * Theme choice state, shared by the icon picker and its tests.
 *
 * Starlight owns the `data-theme` attribute and stores the visitor's choice in
 * `localStorage["starlight-theme"]` (`""` means "follow the system"). This
 * module keeps that contract intact while the site ships an icon-only control.
 */
export type ThemeChoice = "light" | "dark" | "auto";

export const THEME_STORAGE_KEY = "starlight-theme";

export const THEME_CHOICES: readonly ThemeChoice[] = ["light", "dark", "auto"];

/** Any stored value that is not a known choice falls back to the system theme. */
export function parseThemeChoice(value: unknown): ThemeChoice {
  return value === "light" || value === "dark" || value === "auto" ? value : "auto";
}

/** The concrete `data-theme` for a choice, resolving `auto` from the OS. */
export function resolveTheme(choice: ThemeChoice, prefersLight: boolean): "light" | "dark" {
  return choice === "auto" ? (prefersLight ? "light" : "dark") : choice;
}

/** The value Starlight stores: an empty string means automatic. */
export function storageValue(choice: ThemeChoice): string {
  return choice === "auto" ? "" : choice;
}
