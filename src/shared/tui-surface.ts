/**
 * The TUI-surface wire model (plan step 17).
 *
 * Pi's `ctx.ui.custom()` hands the extension a `TUI` and a component factory.
 * The host emulates that TUI, renders the component to ANSI lines and pushes a
 * whole snapshot to the renderer after every change — the same
 * push-the-whole-state shape `oi.state` already uses, so the renderer never
 * reconciles partial updates.
 *
 * The renderer sends `tui.resize` (its measured rows/columns), `tui.input` (raw
 * terminal bytes produced from DOM keys) and `tui.state` (a pull after a tab
 * activation). Input is bytes, not chords, because Pi's components match raw
 * terminal sequences with pi-tui's `matchesKey`.
 *
 * No SDK import: this file is consumed by the node and web TypeScript projects.
 */

/** Host → renderer push with the whole surface state. */
export const TUI_STATE_EVENT = "tui.state";

/** Where a rendered component lives on the surface. */
export const TUI_SLOTS = ["custom", "editor", "footer", "header"] as const;
export type TuiSlot = (typeof TUI_SLOTS)[number];

export function isTuiSlot(value: unknown): value is TuiSlot {
  return typeof value === "string" && (TUI_SLOTS as readonly string[]).includes(value);
}

export interface TuiCursor {
  /** Zero-based row within the frame. */
  row: number;
  /** Zero-based column within the frame, in terminal cells. */
  col: number;
}

/** One component rendered to ANSI lines. */
export interface TuiFrame {
  /** Monotonic per surface; the renderer can skip an older frame. */
  seq: number;
  width: number;
  height: number;
  lines: string[];
  /** Where the hardware cursor should sit, or null for none. */
  cursor: TuiCursor | null;
}

/** The resolved overlay rectangle, in terminal cells. */
export interface TuiBounds {
  row: number;
  col: number;
  width: number;
  height: number;
}

export interface TuiSurfaceSnapshot {
  /** False when no extension component is mounted. */
  active: boolean;
  /** True when the focused component was mounted with `overlay: true`. */
  overlay: boolean;
  /** Overlay rectangle, present only while an overlay is visible. */
  bounds: TuiBounds | null;
  /** The slot currently owning the keyboard. */
  focus: TuiSlot | null;
  custom: TuiFrame | null;
  editor: TuiFrame | null;
  footer: TuiFrame | null;
  header: TuiFrame | null;
}

export const EMPTY_TUI_SURFACE: TuiSurfaceSnapshot = {
  active: false,
  overlay: false,
  bounds: null,
  focus: null,
  custom: null,
  editor: null,
  footer: null,
  header: null,
};

/** Bounds for one frame (defensive caps; the host is trusted but the wire is not). */
const MAX_FRAME_LINES = 1000;
const MAX_LINE_CHARS = 4000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

export function sanitizeTuiCursor(value: unknown): TuiCursor | null {
  const record = asRecord(value);
  const row = asInt(record.row);
  const col = asInt(record.col);
  if (row === null || col === null || row < 0 || col < 0) return null;
  return { row, col };
}

export function sanitizeTuiBounds(value: unknown): TuiBounds | null {
  const record = asRecord(value);
  const row = asInt(record.row);
  const col = asInt(record.col);
  const width = asInt(record.width);
  const height = asInt(record.height);
  if (row === null || col === null || width === null || height === null) return null;
  if (row < 0 || col < 0 || width <= 0 || height <= 0) return null;
  return { row, col, width, height };
}

export function sanitizeTuiFrame(value: unknown): TuiFrame | null {
  const record = asRecord(value);
  const seq = asInt(record.seq);
  const width = asInt(record.width);
  const height = asInt(record.height);
  if (seq === null || width === null || height === null) return null;
  if (width <= 0 || height < 0) return null;
  const rawLines = Array.isArray(record.lines) ? record.lines : [];
  const lines: string[] = [];
  for (const entry of rawLines.slice(0, MAX_FRAME_LINES)) {
    if (typeof entry !== "string") continue;
    lines.push(entry.length > MAX_LINE_CHARS ? entry.slice(0, MAX_LINE_CHARS) : entry);
  }
  return { seq, width, height, lines, cursor: sanitizeTuiCursor(record.cursor) };
}

/** Coerces an untrusted push into a snapshot the renderer can render. */
export function sanitizeTuiSurfaceSnapshot(value: unknown): TuiSurfaceSnapshot {
  const record = asRecord(value);
  const focus = record.focus;
  return {
    active: record.active === true,
    overlay: record.overlay === true,
    bounds: sanitizeTuiBounds(record.bounds),
    focus: isTuiSlot(focus) ? focus : null,
    custom: sanitizeTuiFrame(record.custom),
    editor: sanitizeTuiFrame(record.editor),
    footer: sanitizeTuiFrame(record.footer),
    header: sanitizeTuiFrame(record.header),
  };
}

/** `tui.resize` params: the renderer's measured surface grid. */
export interface TuiResizeRequest {
  rows: number;
  cols: number;
}

export function sanitizeTuiResize(value: unknown): TuiResizeRequest | null {
  const record = asRecord(value);
  const rows = asInt(record.rows);
  const cols = asInt(record.cols);
  if (rows === null || cols === null) return null;
  if (rows < 1 || cols < 1 || rows > 500 || cols > 1000) return null;
  return { rows, cols };
}

/** `tui.input` params: raw terminal bytes. */
export interface TuiInputRequest {
  data: string;
}

export function sanitizeTuiInput(value: unknown): TuiInputRequest | null {
  const record = asRecord(value);
  if (typeof record.data !== "string" || record.data.length === 0) return null;
  return { data: record.data };
}
