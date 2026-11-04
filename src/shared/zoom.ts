/**
 * App-level display zoom (2026-10-30 zoom plan).
 *
 * Electron's `role: "zoomIn"` binds `Ctrl+Shift+=` (the `Plus` key) on
 * Windows/Linux, not the `Ctrl+=` users expect, which is why the menu zoom
 * appeared broken. The app owns the factor instead: these are the discrete
 * levels, the pure stepping arithmetic, and the percentage label. The renderer
 * persists the factor; the main process applies it with
 * `webContents.setZoomFactor`.
 */

/**
 * The supported levels, 50 %–300 %. VS Code's range and a similar step shape:
 * small changes near 100 %, larger ones at the edges where they are useful.
 */
export const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

export const DEFAULT_ZOOM = 1;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;

const EPSILON = 1e-6;

/** Clamps to the range and snaps to the nearest supported level. */
export function clampZoomFactor(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_ZOOM;
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, numeric));
  let best = MIN_ZOOM;
  let distance = Math.abs(clamped - best);
  for (const level of ZOOM_LEVELS) {
    const next = Math.abs(clamped - level);
    if (next < distance) {
      best = level;
      distance = next;
    }
  }
  return best;
}

/** The next level up, or the maximum. */
export function zoomIn(current: unknown): number {
  const factor = clampZoomFactor(current);
  return ZOOM_LEVELS.find((level) => level > factor + EPSILON) ?? MAX_ZOOM;
}

/** The next level down, or the minimum. */
export function zoomOut(current: unknown): number {
  const factor = clampZoomFactor(current);
  for (let index = ZOOM_LEVELS.length - 1; index >= 0; index -= 1) {
    const level = ZOOM_LEVELS[index];
    if (level !== undefined && level < factor - EPSILON) return level;
  }
  return MIN_ZOOM;
}

/** `1.25` → `"125%"`; the label used by the status bar and Settings. */
export function formatZoomPercent(factor: unknown): string {
  return `${Math.round(clampZoomFactor(factor) * 100)}%`;
}
