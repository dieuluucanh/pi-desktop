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
 * The slots are `custom` (a `ctx.ui.custom()` component), `footer` and `header`.
 * There is deliberately no `editor` slot: the desktop always keeps its native
 * composer, and an extension-installed TUI editor is recorded on the UI port for
 * `getEditorComponent()` coordination but never mounted (see
 * `src/host/sdk/extension-ui.ts`). A stale host's `editor` field is ignored by
 * the sanitizer.
 *
 * No SDK import: this file is consumed by the node and web TypeScript projects.
 */

/** Host → renderer push with the whole surface state. */
export const TUI_STATE_EVENT = "tui.state";

/** Where a rendered component lives on the surface. */
export const TUI_SLOTS = ["custom", "footer", "header"] as const;
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
  /**
   * The extension's `ctx.ui.setWidget` key, present only on widget frames.
   * The renderer uses it to identify a widget it owns chrome for (the Workflow
   * todo panel); custom/header/footer frames leave it undefined.
   */
  key?: string;
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

/**
 * One mounted keyboard-bearing surface in the stack (2026-11-22 parity row 28).
 *
 * Pi composites a base `custom` component with an arbitrary overlay stack; the
 * desktop used to carry only the topmost one, so a questionnaire overlay hid
 * the review pane underneath it. Every mounted component now reports its own
 * layer, bottom-to-top, with `id` stable across repaints (a new mount gets a new
 * id) so the renderer can key it and the attention rule can tell a new request
 * from a repaint.
 */
export interface TuiSurfaceLayer {
  /** Stable within one mount; a remount mints a new id. */
  id: string;
  /** True for a `ctx.ui.custom(fn, { overlay: true })` component. */
  overlay: boolean;
  /** Overlay rectangle, present only while a visible overlay has been laid out. */
  bounds: TuiBounds | null;
  /** True for the component that currently owns the keyboard. */
  focused: boolean;
  frame: TuiFrame;
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
  /**
   * The topmost mounted surface (legacy single-slot view). A renderer that
   * understands `layers` renders the whole stack; this stays truthful for an
   * older renderer: it is the frame the stack renders last, focused or not.
   */
  custom: TuiFrame | null;
  footer: TuiFrame | null;
  header: TuiFrame | null;
  /** Component-factory widgets above the editor/dock (plan 2026-10-26, step 5). */
  widgetsAbove: TuiFrame[];
  /** Component-factory widgets below the editor/dock. */
  widgetsBelow: TuiFrame[];
  /** Every mounted keyboard-bearing surface, bottom-to-top. */
  layers: TuiSurfaceLayer[];
}

export const EMPTY_TUI_SURFACE: TuiSurfaceSnapshot = {
  active: false,
  overlay: false,
  bounds: null,
  focus: null,
  custom: null,
  footer: null,
  header: null,
  widgetsAbove: [],
  widgetsBelow: [],
  layers: [],
};

/** Bounds for one frame (defensive caps; the host is trusted but the wire is not). */
const MAX_FRAME_LINES = 1000;
const MAX_LINE_CHARS = 4000;
const MAX_WIDGET_FRAMES = 16;
const MAX_WIDGET_KEY_CHARS = 80;
const MAX_LAYERS = 8;
const MAX_LAYER_ID_CHARS = 120;

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
  const key = typeof record.key === "string" ? record.key.trim() : "";
  const frame: TuiFrame = {
    seq,
    width,
    height,
    lines,
    cursor: sanitizeTuiCursor(record.cursor),
  };
  if (key.length > 0) frame.key = key.slice(0, MAX_WIDGET_KEY_CHARS);
  return frame;
}

/** Coerces one untrusted stack layer, or null when it carries no usable frame. */
export function sanitizeTuiSurfaceLayer(value: unknown): TuiSurfaceLayer | null {
  const record = asRecord(value);
  const frame = sanitizeTuiFrame(record.frame);
  if (!frame) return null;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (id.length === 0) return null;
  return {
    id: id.slice(0, MAX_LAYER_ID_CHARS),
    overlay: record.overlay === true,
    bounds: sanitizeTuiBounds(record.bounds),
    focused: record.focused === true,
    frame,
  };
}

function sanitizeLayers(value: unknown): TuiSurfaceLayer[] {
  if (!Array.isArray(value)) return [];
  const layers: TuiSurfaceLayer[] = [];
  for (const entry of value.slice(0, MAX_LAYERS)) {
    const layer = sanitizeTuiSurfaceLayer(entry);
    if (layer) layers.push(layer);
  }
  return layers;
}

/** Coerces an untrusted push into a snapshot the renderer can render. */
export function sanitizeTuiSurfaceSnapshot(value: unknown): TuiSurfaceSnapshot {
  const record = asRecord(value);
  const focus = record.focus;
  const layers = sanitizeLayers(record.layers);
  const custom = sanitizeTuiFrame(record.custom);
  return {
    active: record.active === true,
    overlay: record.overlay === true,
    bounds: sanitizeTuiBounds(record.bounds),
    focus: isTuiSlot(focus) ? focus : null,
    // A host that only knows the single slot still renders through `custom`.
    custom: custom ?? layers.at(-1)?.frame ?? null,
    footer: sanitizeTuiFrame(record.footer),
    header: sanitizeTuiFrame(record.header),
    widgetsAbove: sanitizeWidgetFrames(record.widgetsAbove),
    widgetsBelow: sanitizeWidgetFrames(record.widgetsBelow),
    layers,
  };
}

/**
 * True when a background tab's surface has just asked for input (row 28).
 *
 * A mounted `custom`/overlay component owns keys and can block until the user
 * answers, so its arrival must be visible without yanking the user out of
 * another pane. A repaint of the same mount is not a new request, and an empty
 * surface is never attention. Whether the tab is activated at all stays the
 * app's routing decision; this predicate only answers "is this new work?".
 */
export function tuiSurfaceNeedsAttention(
  previous: TuiSurfaceSnapshot | undefined,
  next: TuiSurfaceSnapshot,
): boolean {
  const topId = next.layers.at(-1)?.id ?? (next.custom ? "custom" : null);
  if (topId === null) return false;
  const previousId = previous?.layers.at(-1)?.id ?? (previous?.custom ? "custom" : null);
  if (previousId === null) return true;
  return previousId !== topId;
}

function sanitizeWidgetFrames(value: unknown): TuiFrame[] {
  if (!Array.isArray(value)) return [];
  const frames: TuiFrame[] = [];
  for (const entry of value.slice(0, MAX_WIDGET_FRAMES)) {
    const frame = sanitizeTuiFrame(entry);
    if (frame) frames.push(frame);
  }
  return frames;
}

/**
 * A widget frame whose whole content is one line can become a footer column
 * instead of its own strip (2026-10-31 UI plan). Empty frames are deliberately
 * not "inline": they carry nothing and belong to the strip's lifecycle.
 */
export function isSingleLineFrame(frame: TuiFrame): boolean {
  return frame.lines.length === 1;
}

/** Splits below-editor widgets into the footer columns and the remaining strip. */
export function splitSingleLineFrames(frames: readonly TuiFrame[]): {
  inline: TuiFrame[];
  stacked: TuiFrame[];
} {
  const inline: TuiFrame[] = [];
  const stacked: TuiFrame[] = [];
  for (const frame of frames) (isSingleLineFrame(frame) ? inline : stacked).push(frame);
  return { inline, stacked };
}

/** `tui.resize` params: the renderer's measured surface grid. */ export interface TuiResizeRequest {
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

/**
 * `tui.input` result: what the host did with the bytes.
 *
 * `consumed` means an extension handler or TUI listener claimed the key, so the
 * renderer must not also run its own default action (in particular, Escape must
 * not fall through to `stopRun`). `dispatched` means the bytes reached at least
 * one handler, listener or component — a key nobody looked at is not an
 * interruption.
 */
export interface TuiInputResult {
  ok: true;
  consumed: boolean;
  dispatched: boolean;
}

export function sanitizeTuiInput(value: unknown): TuiInputRequest | null {
  const record = asRecord(value);
  if (typeof record.data !== "string" || record.data.length === 0) return null;
  return { data: record.data };
}
