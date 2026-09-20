/**
 * Extension shortcuts shared model (plan step 15).
 *
 * Extensions register keyboard shortcuts (`ExtensionShortcut`: a key id, an
 * optional description, a handler and the owning extension path). The session
 * host surfaces them through `shortcuts.list` and runs a handler through
 * `shortcuts.invoke`, so the handler executes with the session's extension
 * context — exactly as it would from terminal Pi.
 *
 * Everything here is pure: no SDK import, no DOM, no filesystem.
 */

/** One extension-registered shortcut as the renderer consumes it. */
export interface ExtensionShortcutSummary {
  /** The key chord, e.g. `ctrl+g`. */
  key: string;
  description?: string;
  /** Absolute path of the extension that registered it. */
  extensionPath: string;
  /** Human label for the owner (basename of the extension path). */
  source: string;
}

/** `shortcuts.list` payload. */
export interface ShortcutsSnapshot {
  shortcuts: ExtensionShortcutSummary[];
  /** Loader diagnostics Pi reported for shortcuts (collisions, bad keys). */
  diagnostics: ShortcutDiagnostic[];
  loadedAt: number;
}

export interface ShortcutDiagnostic {
  type: "warning" | "error" | "collision";
  message: string;
  path?: string;
}

export const EMPTY_SHORTCUTS: ShortcutsSnapshot = {
  shortcuts: [],
  diagnostics: [],
  loadedAt: 0,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || path;
}

export function sanitizeShortcutSummary(value: unknown): ExtensionShortcutSummary | null {
  const record = asRecord(value);
  const key = asString(record.key);
  const extensionPath = asString(record.extensionPath);
  if (!key || !extensionPath) return null;
  const description = asString(record.description);
  return {
    key,
    ...(description ? { description } : {}),
    extensionPath,
    source: asString(record.source) ?? basenameOf(extensionPath),
  };
}

function sanitizeDiagnostic(value: unknown): ShortcutDiagnostic | null {
  const record = asRecord(value);
  const message = asString(record.message);
  if (!message) return null;
  const type = record.type;
  const path = asString(record.path);
  return {
    type: type === "error" || type === "collision" ? type : "warning",
    message,
    ...(path ? { path } : {}),
  };
}

export function sanitizeShortcutsSnapshot(value: unknown): ShortcutsSnapshot {
  const record = asRecord(value);
  const shortcuts = Array.isArray(record.shortcuts)
    ? record.shortcuts
        .map(sanitizeShortcutSummary)
        .filter((entry): entry is ExtensionShortcutSummary => entry !== null)
    : [];
  const diagnostics = Array.isArray(record.diagnostics)
    ? record.diagnostics
        .map(sanitizeDiagnostic)
        .filter((entry): entry is ShortcutDiagnostic => entry !== null)
    : [];
  const loadedAt =
    typeof record.loadedAt === "number" && Number.isFinite(record.loadedAt) ? record.loadedAt : 0;
  return { shortcuts, diagnostics, loadedAt };
}

/** Stable sort for display: first by key, then by owner. */
export function sortShortcuts(
  shortcuts: readonly ExtensionShortcutSummary[],
): ExtensionShortcutSummary[] {
  return [...shortcuts].sort(
    (a, b) => a.key.localeCompare(b.key) || a.source.localeCompare(b.source),
  );
}
