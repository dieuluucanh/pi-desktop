/**
 * The extension-UI wire model (plan step 16, half A).
 *
 * An extension calls `ctx.ui.select()` in the host process; the host mints an id,
 * emits `oi.request`, and resolves when the app answers `oi.respond`. The dialog
 * params are borrowed verbatim from Pi's RPC mode (`method` + `title` + friends),
 * so a client that speaks RPC shapes already understands them.
 *
 * The fire-and-forget members (`notify`, `setStatus`, `setWidget`, working state,
 * `setTitle`, editor text) are represented as a small snapshot that the host
 * pushes after every change. Keeping the snapshot pure here means the host and the
 * renderer agree on one shape and a status can never be half-applied.
 *
 * No SDK import: this file is consumed by the node and web TypeScript projects.
 */

/** Dialog methods an extension can block on; identical to Pi's RPC methods. */
export const EXTENSION_DIALOG_METHODS = ["select", "confirm", "input", "editor"] as const;
export type ExtensionDialogMethod = (typeof EXTENSION_DIALOG_METHODS)[number];

export function isExtensionDialogMethod(value: unknown): value is ExtensionDialogMethod {
  return (
    typeof value === "string" && (EXTENSION_DIALOG_METHODS as readonly string[]).includes(value)
  );
}

/** A dialog waiting for the user, assembled from an `oi.request` frame. */
export interface ExtensionDialogRequest {
  id: string;
  method: ExtensionDialogMethod;
  title: string;
  /** `select` only. */
  options: string[];
  /** `confirm` only. */
  message: string;
  /** `input` only. */
  placeholder: string | null;
  /** `editor` only. */
  prefill: string | null;
  /** Auto-dismiss countdown from the extension's `opts.timeout`, in ms. */
  timeout: number | null;
  /** The tab whose host asked (filled by the renderer, never sent). */
  tabId: string;
  /** Arrival time, for queue ordering and the countdown. */
  at: number;
}

/** Host event names the extension UI uses. */
export const EXTENSION_UI_REQUEST_EVENT = "oi.request";
export const EXTENSION_UI_STATE_EVENT = "oi.state";
export const EXTENSION_UI_NOTIFY_EVENT = "oi.notify";
export const EXTENSION_UI_THEME_EVENT = "oi.theme";
export const SESSION_SHUTDOWN_REQUEST_EVENT = "session.shutdown_requested";

/** Notification kinds Pi accepts (`notify(message, type?)`). */
export const EXTENSION_NOTIFY_TYPES = ["info", "warning", "error"] as const;
export type ExtensionNotifyType = (typeof EXTENSION_NOTIFY_TYPES)[number];

export interface ExtensionNotification {
  id: string;
  message: string;
  type: ExtensionNotifyType;
  tabId: string;
  at: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Parses one `oi.request` payload into a dialog request, or null when it is not
 * an extension dialog (a provider-login prompt carries `source` and is routed
 * elsewhere).
 */
export function parseExtensionDialogRequest(
  payload: unknown,
  tabId: string,
  at = Date.now(),
): ExtensionDialogRequest | null {
  const record = asRecord(payload);
  const id = asString(record.id);
  const method = record.method;
  if (!id || !isExtensionDialogMethod(method)) return null;
  const params = asRecord(record.params);
  // A provider-login prompt reuses `oi.request` but tags its params with a
  // `source`; it is routed to the Connections dialog, not an extension dialog.
  if (params.source !== undefined) return null;
  const timeout =
    typeof params.timeout === "number" && Number.isFinite(params.timeout) && params.timeout > 0
      ? params.timeout
      : null;
  return {
    id,
    method,
    title: asString(params.title) ?? "",
    options: asStringArray(params.options),
    message: typeof params.message === "string" ? params.message : "",
    placeholder: asString(params.placeholder),
    prefill: typeof params.prefill === "string" ? params.prefill : null,
    timeout,
    tabId,
    at,
  };
}

/** Parses an `oi.notify` payload. */
export function parseExtensionNotification(
  payload: unknown,
  tabId: string,
  at = Date.now(),
): ExtensionNotification | null {
  const record = asRecord(payload);
  const message = asString(record.message);
  if (!message) return null;
  const type = record.type ?? record.notifyType;
  return {
    id: asString(record.id) ?? `${tabId}:${at}`,
    message,
    type: (EXTENSION_NOTIFY_TYPES as readonly string[]).includes(type as string)
      ? (type as ExtensionNotifyType)
      : "info",
    tabId,
    at,
  };
}

/** Where a string widget renders relative to the composer. */
export const EXTENSION_WIDGET_PLACEMENTS = ["aboveEditor", "belowEditor"] as const;
export type ExtensionWidgetPlacement = (typeof EXTENSION_WIDGET_PLACEMENTS)[number];

export interface ExtensionWidget {
  key: string;
  lines: string[];
  placement: ExtensionWidgetPlacement;
}

export interface ExtensionWorkingState {
  /** Custom working message, or null for the app default. */
  message: string | null;
  /** Whether the working row shows; null means the app default (while running). */
  visible: boolean | null;
  /** Custom spinner frames, or null for the default animation. */
  frames: string[] | null;
  intervalMs: number | null;
}

/** A host-issued edit of the composer buffer (`setEditorText` / `pasteToEditor`). */
export interface ExtensionEditorCommand {
  /** Monotonic per host: the renderer applies each seq exactly once. */
  seq: number;
  /** The full text the composer should hold. */
  text: string;
}

/**
 * The extension UI state of one session host. Pushed as a whole after every
 * change, so the renderer never has to reconcile partial updates.
 */
export interface ExtensionUiSnapshot {
  statuses: Record<string, string>;
  widgets: ExtensionWidget[];
  working: ExtensionWorkingState;
  hiddenThinkingLabel: string | null;
  title: string | null;
  /** null = leave the app's own expand state alone. */
  toolsExpanded: boolean | null;
  /** Number of extension autocomplete providers registered (diagnostics). */
  autocompleteProviders: number;
  /** The last composer edit the host asked for, or null. */
  editor: ExtensionEditorCommand | null;
}

export const EMPTY_EXTENSION_WORKING: ExtensionWorkingState = {
  message: null,
  visible: null,
  frames: null,
  intervalMs: null,
};

export const EMPTY_EXTENSION_UI: ExtensionUiSnapshot = {
  statuses: {},
  widgets: [],
  working: { ...EMPTY_EXTENSION_WORKING },
  hiddenThinkingLabel: null,
  title: null,
  toolsExpanded: null,
  autocompleteProviders: 0,
  editor: null,
};

/** Sanitizes one untrusted widget entry. */
export function sanitizeExtensionWidget(value: unknown): ExtensionWidget | null {
  const record = asRecord(value);
  const key = asString(record.key);
  if (!key) return null;
  const placement = record.placement;
  return {
    key,
    lines: asStringArray(record.lines),
    placement: (EXTENSION_WIDGET_PLACEMENTS as readonly string[]).includes(placement as string)
      ? (placement as ExtensionWidgetPlacement)
      : "aboveEditor",
  };
}

/** Coerces an untrusted snapshot into the shape the UI can render. */
export function sanitizeExtensionUiSnapshot(value: unknown): ExtensionUiSnapshot {
  const record = asRecord(value);
  const statuses: Record<string, string> = {};
  for (const [key, text] of Object.entries(asRecord(record.statuses))) {
    if (typeof text === "string") statuses[key] = text;
  }
  const widgets: ExtensionWidget[] = [];
  if (Array.isArray(record.widgets)) {
    for (const entry of record.widgets) {
      const widget = sanitizeExtensionWidget(entry);
      if (widget) widgets.push(widget);
    }
  }
  const working = asRecord(record.working);
  const editor = asRecord(record.editor);
  const seq = editor.seq;
  return {
    statuses,
    widgets,
    working: {
      message: asString(working.message),
      visible: typeof working.visible === "boolean" ? working.visible : null,
      frames: Array.isArray(working.frames) ? asStringArray(working.frames) : null,
      intervalMs:
        typeof working.intervalMs === "number" && Number.isFinite(working.intervalMs)
          ? working.intervalMs
          : null,
    },
    hiddenThinkingLabel: asString(record.hiddenThinkingLabel),
    title: asString(record.title),
    toolsExpanded: typeof record.toolsExpanded === "boolean" ? record.toolsExpanded : null,
    autocompleteProviders:
      typeof record.autocompleteProviders === "number" &&
      Number.isFinite(record.autocompleteProviders)
        ? record.autocompleteProviders
        : 0,
    editor:
      typeof seq === "number" && Number.isFinite(seq) && typeof editor.text === "string"
        ? { seq, text: editor.text }
        : null,
  };
}

/** Widgets for one placement, in registration order. */
export function extensionWidgetsByPlacement(
  snapshot: ExtensionUiSnapshot,
  placement: ExtensionWidgetPlacement,
): ExtensionWidget[] {
  return snapshot.widgets.filter((widget) => widget.placement === placement);
}

/* ------------------------------------------------------------------------- *
 * Extension autocomplete providers (plan step 16 / step 7 seam)
 * ------------------------------------------------------------------------- */

/**
 * A structural mirror of pi-tui's `AutocompleteProvider`, exactly like the
 * renderer's `completion/types.ts`. Extension providers run in the host (their
 * factory functions cannot cross the frame boundary), so the host evaluates them
 * and returns plain data to the composer.
 */
export interface ExtensionCompletionItem {
  value: string;
  label: string;
  description?: string;
  /**
   * Provenance of a base provider item that a delegating extension returns
   * unchanged. A wire item without a source is treated as an extension item.
   */
  source?: string;
  /**
   * Argument items replace their prefix verbatim; "use " already carries the
   * trailing space. Preserved across the host chain so delegation cannot add a
   * second space.
   */
  appendSpace?: boolean;
}

export interface ExtensionCompletionSuggestions {
  prefix: string;
  items: ExtensionCompletionItem[];
}

export interface ExtensionCompletionProvider {
  triggerCharacters?: string[];
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<ExtensionCompletionSuggestions | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: ExtensionCompletionItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

/** Pi's `addAutocompleteProvider` factory shape. */
export type ExtensionCompletionProviderFactory = (
  current: ExtensionCompletionProvider,
) => ExtensionCompletionProvider;

export interface ExtensionCompletionRequest {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
  force?: boolean;
  /** What the renderer's built-in providers produced for this keystroke. */
  base: ExtensionCompletionSuggestions | null;
}

export interface ExtensionCompletionApplyRequest {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
  item: ExtensionCompletionItem;
  prefix: string;
}

export interface ExtensionCompletionResult {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

function sanitizeCompletionItems(value: unknown): ExtensionCompletionItem[] {
  if (!Array.isArray(value)) return [];
  const items: ExtensionCompletionItem[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const itemValue = asString(record.value);
    const label = asString(record.label);
    if (!itemValue || !label) continue;
    items.push({
      value: itemValue,
      label,
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(typeof record.source === "string" && record.source.length > 0
        ? { source: record.source }
        : {}),
      ...(typeof record.appendSpace === "boolean" ? { appendSpace: record.appendSpace } : {}),
    });
  }
  return items;
}

export function sanitizeCompletionSuggestions(
  value: unknown,
): ExtensionCompletionSuggestions | null {
  const record = asRecord(value);
  if (typeof record.prefix !== "string") return null;
  const items = sanitizeCompletionItems(record.items);
  if (items.length === 0) return null;
  return { prefix: record.prefix, items };
}

export function sanitizeCompletionRequest(value: unknown): ExtensionCompletionRequest | null {
  const record = asRecord(value);
  const lines = asStringArray(record.lines);
  const cursorLine = record.cursorLine;
  const cursorCol = record.cursorCol;
  if (lines.length === 0 || typeof cursorLine !== "number" || typeof cursorCol !== "number") {
    return null;
  }
  return {
    lines,
    cursorLine,
    cursorCol,
    ...(record.force === true ? { force: true } : {}),
    base: sanitizeCompletionSuggestions(record.base),
  };
}

export function sanitizeCompletionApplyRequest(
  value: unknown,
): ExtensionCompletionApplyRequest | null {
  const record = asRecord(value);
  const lines = asStringArray(record.lines);
  const cursorLine = record.cursorLine;
  const cursorCol = record.cursorCol;
  const prefix = record.prefix;
  const item = sanitizeCompletionItems([record.item])[0];
  if (
    lines.length === 0 ||
    typeof cursorLine !== "number" ||
    typeof cursorCol !== "number" ||
    typeof prefix !== "string" ||
    !item
  ) {
    return null;
  }
  return { lines, cursorLine, cursorCol, item, prefix };
}

/** The default apply: replace `prefix` before the caret, then add a space unless verbatim. */
export function applyCompletionInPlace(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  item: ExtensionCompletionItem,
  prefix: string,
): ExtensionCompletionResult {
  const next = [...lines];
  const line = next[cursorLine] ?? "";
  const start = Math.max(0, cursorCol - prefix.length);
  const insertion = item.appendSpace === false ? item.value : `${item.value} `;
  next[cursorLine] = `${line.slice(0, start)}${insertion}${line.slice(cursorCol)}`;
  return { lines: next, cursorLine, cursorCol: start + insertion.length };
}
