/**
 * Terminal font resolution (2026-11-05 terminal follow-up plan, step 2).
 *
 * xterm measures its cell grid on a canvas (`ctx.font = "<size>px <family>"`),
 * and a canvas font string does not resolve CSS custom properties. Passing
 * `var(--font-mono)` therefore silently falls back to the canvas default
 * (`10px sans-serif`), which is both the wrong size and the wrong shape. Resolve
 * the token to a concrete family list before xterm sees it.
 *
 * The resolver is pure so it can be tested without a DOM or xterm; the document
 * helper is the only place that touches `getComputedStyle`.
 */

export const FALLBACK_TERMINAL_FONT_FAMILY = "monospace";

const CSS_VARIABLE_REFERENCE = /var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g;

/**
 * Resolves `fontFamily` (or the app's `--font-mono` when it is null) to a
 * concrete CSS family list. Any `var(--token)` is expanded once through
 * `readVariable`; an empty or still-unresolved result falls back to a valid
 * canvas font.
 */
export function resolveTerminalFontFamily(
  fontFamily: string | null,
  readVariable: (name: string) => string,
): string {
  const requested = fontFamily?.trim() || "var(--font-mono)";
  const expanded = requested.replace(CSS_VARIABLE_REFERENCE, (_match, name: string) =>
    readVariable(name).trim(),
  );
  const trimmed = expanded.trim();
  if (trimmed.length === 0 || trimmed.includes("var(")) return FALLBACK_TERMINAL_FONT_FAMILY;
  return trimmed;
}

/** Reads the active theme's `--font-mono`; safe under the renderer test env. */
export function terminalFontFamilyFromDocument(fontFamily: string | null): string {
  if (typeof document === "undefined") return resolveTerminalFontFamily(fontFamily, () => "");
  const styles = getComputedStyle(document.documentElement);
  return resolveTerminalFontFamily(fontFamily, (name) => styles.getPropertyValue(name));
}
