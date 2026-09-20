/**
 * The extension-renderer wire model (plan step 18).
 *
 * Pi's extensions can own the rendering of a custom message, a custom entry or a
 * tool call/result: `registerMessageRenderer`, `registerEntryRenderer`, and a
 * tool definition's `renderCall`/`renderResult`. Those are functions in the host
 * process returning pi-tui `Component`s, so they cannot cross the frame
 * boundary. The host runs them and returns ANSI lines; the renderer turns those
 * into HTML with the step-17 `AnsiBlock`.
 *
 * Rendering is **request/response** rather than a pushed frame: `expanded` is
 * the app's expand state, `width` is the transcript's measured cell width, and a
 * streaming tool's result changes on every `tool_execution_update`. The renderer
 * is the only side that knows those, so it asks for a render and re-asks while a
 * tool streams — the same options Pi's `ToolRenderContext` carries
 * (`isPartial`, `expanded`, `isError`, `showImages`, `argsComplete`).
 *
 * No SDK import: this file is consumed by the node and web TypeScript projects.
 */

/** Host → renderer push when an extension calls `context.invalidate()`. */
export const EXTENSION_RENDER_INVALIDATE_EVENT = "render.invalidate";

/** Which extension renderer to run. */
export const RENDER_TARGETS = ["message", "entry", "tool"] as const;
export type RenderTarget = (typeof RENDER_TARGETS)[number];

export function isRenderTarget(value: unknown): value is RenderTarget {
  return typeof value === "string" && (RENDER_TARGETS as readonly string[]).includes(value);
}

/** `MessageRenderOptions.outputPad` default, matching Pi's own default. */
export const DEFAULT_OUTPUT_PAD = 1;

/** `render.request` params. */
export interface RenderRequest {
  target: RenderTarget;
  /** `customType` for a message/entry; the tool name for a tool. */
  type: string;
  /** Transcript width in terminal cells. */
  width: number;
  expanded: boolean;
  /** Message/entry only: `MessageRenderOptions.outputPad`. */
  outputPad?: number;
  /** Message only: the raw `CustomMessage` (forwarded verbatim). */
  message?: unknown;
  /** Entry only: the raw `CustomEntry` (forwarded verbatim). */
  entry?: unknown;
  /** Tool only. */
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  isPartial?: boolean;
  isError?: boolean;
  argsComplete?: boolean;
  showImages?: boolean;
}

/** `render.request` result. */
export interface RenderedFrame {
  /**
   * False when the item has no renderer (or its renderer threw): the renderer
   * shows its native card, which is Pi's documented fallback.
   */
  rendered: boolean;
  width: number;
  lines: string[];
  /** Present when a renderer existed but threw; the fallback is still native. */
  error?: string;
}

/** `render.markdown` params: a registered `MarkdownTransformer` context. */
export interface MarkdownTransformRequest {
  text: string;
  messageType: "user" | "assistant" | "assistant-thinking";
  isStreaming: boolean;
  /** `availableWidth` in the transform context. */
  width: number;
}

export interface MarkdownTransformResult {
  text: string;
  /** True when at least one transformer changed the text. */
  transformed: boolean;
}

const MESSAGE_TYPES = ["user", "assistant", "assistant-thinking"] as const;
type MessageType = (typeof MESSAGE_TYPES)[number];

const MAX_TYPE_CHARS = 200;
const MAX_TEXT_CHARS = 200_000;
const MAX_FRAME_LINES = 1000;
const MAX_LINE_CHARS = 4000;
const MAX_OUTPUT_PAD = 20;
const MAX_WIDTH = 1000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function clampWidth(value: unknown): number | null {
  const width = asInt(value);
  if (width === null || width < 1) return null;
  return Math.min(MAX_WIDTH, width);
}

/** Only forwards a payload field when the frame actually carries it. */
function optional(value: unknown, key: string): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}

/**
 * Coerces an untrusted `render.request` into a request, or null when the target,
 * type or width is missing. The `message`/`entry`/`args`/`result` payloads are
 * opaque SDK shapes and travel verbatim (the frame-size guard is the host's).
 */
export function sanitizeRenderRequest(value: unknown): RenderRequest | null {
  const record = asRecord(value);
  if (!isRenderTarget(record.target)) return null;
  const type = typeof record.type === "string" ? record.type.trim() : "";
  if (type.length === 0) return null;
  const width = clampWidth(record.width);
  if (width === null) return null;
  const outputPad = asInt(record.outputPad);
  const toolCallId =
    typeof record.toolCallId === "string" && record.toolCallId.length > 0
      ? record.toolCallId.slice(0, MAX_TYPE_CHARS)
      : undefined;
  return {
    target: record.target,
    type: type.slice(0, MAX_TYPE_CHARS),
    width,
    expanded: record.expanded === true,
    ...(outputPad === null ? {} : { outputPad: Math.min(MAX_OUTPUT_PAD, Math.max(0, outputPad)) }),
    ...optional(record.message, "message"),
    ...optional(record.entry, "entry"),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...optional(record.args, "args"),
    ...optional(record.result, "result"),
    ...(record.isPartial === true ? { isPartial: true } : {}),
    ...(record.isError === true ? { isError: true } : {}),
    ...(record.argsComplete === true ? { argsComplete: true } : {}),
    // `showImages` defaults to true in Pi, so `false` must survive the wire.
    ...(typeof record.showImages === "boolean" ? { showImages: record.showImages } : {}),
  };
}

/** Coerces an untrusted `render.request` result into a frame the renderer shows. */
export function sanitizeRenderedFrame(value: unknown): RenderedFrame | null {
  const record = asRecord(value);
  if (typeof record.rendered !== "boolean") return null;
  const width = clampWidth(record.width);
  if (width === null) return null;
  const rawLines = Array.isArray(record.lines) ? record.lines : [];
  const lines: string[] = [];
  for (const entry of rawLines.slice(0, MAX_FRAME_LINES)) {
    if (typeof entry !== "string") continue;
    lines.push(entry.length > MAX_LINE_CHARS ? entry.slice(0, MAX_LINE_CHARS) : entry);
  }
  return {
    rendered: record.rendered,
    width,
    lines,
    ...(typeof record.error === "string" && record.error.length > 0
      ? { error: record.error.slice(0, MAX_LINE_CHARS) }
      : {}),
  };
}

export function sanitizeMarkdownTransformRequest(value: unknown): MarkdownTransformRequest | null {
  const record = asRecord(value);
  if (typeof record.text !== "string") return null;
  const messageType = record.messageType;
  if (!(MESSAGE_TYPES as readonly string[]).includes(messageType as string)) return null;
  const width = clampWidth(record.width) ?? 80;
  return {
    text: record.text.slice(0, MAX_TEXT_CHARS),
    messageType: messageType as MessageType,
    isStreaming: record.isStreaming === true,
    width,
  };
}

export function sanitizeMarkdownTransformResult(value: unknown): MarkdownTransformResult | null {
  const record = asRecord(value);
  if (typeof record.text !== "string") return null;
  return {
    text: record.text.slice(0, MAX_TEXT_CHARS),
    transformed: record.transformed === true,
  };
}
