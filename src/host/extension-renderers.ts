/**
 * The extension renderer registry (plan step 18).
 *
 * Pi lets an extension own how one of its items renders: `registerMessageRenderer`
 * for a `CustomMessageEntry`, `registerEntryRenderer` for a `CustomEntry`, and a
 * tool definition's `renderCall`/`renderResult`. Those are functions that return
 * pi-tui `Component`s, so they stay in the host; this registry runs them and
 * returns ANSI lines for the renderer to display.
 *
 * It is deliberately SDK-free: the runner, the `Theme` and the components are all
 * structural, so the whole registry is unit-tested with fakes. The SDK supplies
 * the real objects through `bind()` in `src/host/sdk/extension-ui.ts`.
 *
 * Two Pi behaviours are load-bearing here:
 *
 *  - **A throwing renderer falls back, it never propagates.** Pi catches a
 *    renderer error and shows its own fallback; the app's fallback is the native
 *    HTML card, so a throw becomes `{ rendered: false, error }`.
 *  - **Renderer state is per tool call.** `ToolRenderContext.state` and
 *    `lastComponent` persist across the call/result renders for one
 *    `toolCallId`; the registry keeps that record and drops it on rebind.
 */

import {
  DEFAULT_OUTPUT_PAD,
  EXTENSION_RENDER_INVALIDATE_EVENT,
  sanitizeMarkdownTransformRequest,
  sanitizeRenderRequest,
  type MarkdownTransformRequest,
  type MarkdownTransformResult,
  type RenderRequest,
  type RenderedFrame,
} from "../shared/extension-render";
import type { HostMethod } from "../shared/host-protocol";
import type { HostHandler } from "./service";

/** A structural pi-tui `Component`. */
export interface RendererComponent {
  render(width: number): string[];
  invalidate?(): void;
  dispose?(): void;
}

/** The subset of Pi's `ToolRenderContext` a renderer reads. */
export interface ToolRenderContextLike {
  args: unknown;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: RendererComponent | undefined;
  state: Record<string, unknown>;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
}

export type MessageRendererLike = (
  message: unknown,
  options: { expanded: boolean; outputPad: number },
  theme: unknown,
) => RendererComponent | undefined;

export type EntryRendererLike = (
  entry: unknown,
  options: { expanded: boolean },
  theme: unknown,
) => RendererComponent | undefined;

export type ToolCallRendererLike = (
  args: unknown,
  theme: unknown,
  context: ToolRenderContextLike,
) => RendererComponent;

export type ToolResultRendererLike = (
  result: unknown,
  options: { expanded: boolean; isPartial: boolean },
  theme: unknown,
  context: ToolRenderContextLike,
) => RendererComponent;

/** A structural `ToolDefinition`; only the rendering half is read. */
export interface ToolDefinitionLike {
  name?: string;
  renderShell?: "default" | "self";
  renderCall?: ToolCallRendererLike;
  renderResult?: ToolResultRendererLike;
}

export type MarkdownTransformerLike = (
  markdown: string,
  context: { messageType: string; isStreaming: boolean; availableWidth: number },
) => string;

/** The live `ExtensionRunner` surface the registry reads. */
export interface RendererRunner {
  getMessageRenderer?(customType: string): MessageRendererLike | undefined;
  getEntryRenderer?(customType: string): EntryRendererLike | undefined;
  getMarkdownTransformers?(): MarkdownTransformerLike[];
  getToolDefinition?(toolName: string): ToolDefinitionLike | undefined;
}

export interface RendererBinding {
  runner: RendererRunner | null;
  /**
   * Resolves the current Pi `Theme` at render time: an extension that switches
   * theme must not keep rendering with the previous one's colours.
   */
  theme: () => unknown;
  /** The session cwd a `ToolRenderContext` reports. */
  cwd: string;
}

export interface ExtensionRendererPort {
  /** Points the registry at a session's runner (called on every rebind). */
  bind(binding: RendererBinding): void;
  render(request: RenderRequest): RenderedFrame;
  transformMarkdown(request: MarkdownTransformRequest): MarkdownTransformResult;
  handlers(): Partial<Record<HostMethod, HostHandler>>;
  dispose(reason: string): void;
}

export interface ExtensionRendererOptions {
  /** Pushes `render.invalidate` when a renderer asks for a redraw. */
  emit(event: string, payload?: unknown): void;
}

interface ToolRecord {
  state: Record<string, unknown>;
  callComponent: RendererComponent | undefined;
  resultComponent: RendererComponent | undefined;
  args: unknown;
  executionStarted: boolean;
  argsComplete: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Calls a renderer lookup defensively: a broken runner must not take the app down. */
function safeLookup<T>(read: () => T): T | undefined {
  try {
    return read() ?? undefined;
  } catch {
    return undefined;
  }
}

function componentLines(component: RendererComponent | undefined, width: number): string[] {
  if (!component || typeof component.render !== "function") return [];
  const lines = component.render(Math.max(1, width));
  return Array.isArray(lines)
    ? lines.filter((line): line is string => typeof line === "string")
    : [];
}

export function createExtensionRendererRegistry(
  options: ExtensionRendererOptions,
): ExtensionRendererPort {
  let binding: RendererBinding | null = null;
  const toolRecords = new Map<string, ToolRecord>();

  const notRendered = (width: number, error?: string): RenderedFrame => ({
    rendered: false,
    width,
    lines: [],
    ...(error ? { error } : {}),
  });

  const disposeRecords = (): void => {
    for (const record of toolRecords.values()) {
      record.callComponent?.dispose?.();
      record.resultComponent?.dispose?.();
    }
    toolRecords.clear();
  };

  const recordFor = (toolCallId: string): ToolRecord => {
    const existing = toolRecords.get(toolCallId);
    if (existing) return existing;
    const created: ToolRecord = {
      state: {},
      callComponent: undefined,
      resultComponent: undefined,
      args: undefined,
      executionStarted: false,
      argsComplete: false,
    };
    toolRecords.set(toolCallId, created);
    return created;
  };

  const makeContext = (
    record: ToolRecord,
    request: RenderRequest,
    lastComponent: RendererComponent | undefined,
  ): ToolRenderContextLike => ({
    args: request.args,
    toolCallId: request.toolCallId ?? "",
    invalidate: () => {
      if (request.toolCallId) {
        options.emit(EXTENSION_RENDER_INVALIDATE_EVENT, { toolCallId: request.toolCallId });
      }
    },
    lastComponent,
    state: record.state,
    cwd: binding?.cwd ?? "",
    executionStarted: record.executionStarted,
    argsComplete: record.argsComplete,
    isPartial: request.isPartial === true,
    expanded: request.expanded,
    // Pi defaults `showImages` to true; the wire only carries an explicit value.
    showImages: request.showImages !== false,
    isError: request.isError === true,
  });

  const renderTool = (runner: RendererRunner, request: RenderRequest): RenderedFrame => {
    const definition = safeLookup(() => runner.getToolDefinition?.(request.type));
    if (!definition || (!definition.renderCall && !definition.renderResult)) {
      return notRendered(request.width);
    }
    const toolCallId = request.toolCallId ?? "";
    const record = recordFor(toolCallId);
    record.args = request.args;
    if (request.result !== undefined || request.argsComplete === true) {
      record.executionStarted = true;
    }
    record.argsComplete = request.argsComplete === true || request.result !== undefined;

    const lines: string[] = [];
    if (definition.renderCall) {
      try {
        const component = definition.renderCall(
          request.args,
          binding?.theme(),
          makeContext(record, request, record.callComponent),
        );
        record.callComponent = component;
        lines.push(...componentLines(component, request.width));
      } catch (error) {
        return notRendered(request.width, errorMessage(error));
      }
    }
    if (request.result !== undefined && definition.renderResult) {
      try {
        const component = definition.renderResult(
          request.result,
          { expanded: request.expanded, isPartial: request.isPartial === true },
          binding?.theme(),
          makeContext(record, request, record.resultComponent),
        );
        record.resultComponent = component;
        lines.push(...componentLines(component, request.width));
      } catch (error) {
        return notRendered(request.width, errorMessage(error));
      }
    }
    if (lines.length === 0) return notRendered(request.width);
    return { rendered: true, width: request.width, lines };
  };

  const render = (request: RenderRequest): RenderedFrame => {
    const runner = binding?.runner;
    if (!runner) return notRendered(request.width);
    if (request.target === "tool") return renderTool(runner, request);

    const renderer =
      request.target === "message"
        ? safeLookup(() => runner.getMessageRenderer?.(request.type))
        : safeLookup(() => runner.getEntryRenderer?.(request.type));
    if (!renderer) return notRendered(request.width);
    try {
      const component =
        request.target === "message"
          ? (renderer as MessageRendererLike)(
              request.message,
              { expanded: request.expanded, outputPad: request.outputPad ?? DEFAULT_OUTPUT_PAD },
              binding?.theme(),
            )
          : (renderer as EntryRendererLike)(
              request.entry,
              { expanded: request.expanded },
              binding?.theme(),
            );
      const lines = componentLines(component, request.width);
      if (lines.length === 0) return notRendered(request.width);
      return { rendered: true, width: request.width, lines };
    } catch (error) {
      return notRendered(request.width, errorMessage(error));
    }
  };

  const transformMarkdown = (request: MarkdownTransformRequest): MarkdownTransformResult => {
    const transformers = safeLookup(() => binding?.runner?.getMarkdownTransformers?.()) ?? [];
    const context = {
      messageType: request.messageType,
      isStreaming: request.isStreaming,
      availableWidth: request.width,
    };
    let text = request.text;
    let transformed = false;
    for (const transformer of transformers) {
      try {
        const next = transformer(text, context);
        if (typeof next === "string" && next !== text) {
          text = next;
          transformed = true;
        }
      } catch {
        // Pi keeps the current markdown and continues with the next transformer.
      }
    }
    return { text, transformed };
  };

  return {
    bind(next) {
      disposeRecords();
      binding = next;
    },

    render,
    transformMarkdown,

    handlers: () => ({
      "render.request": (params) => {
        const request = sanitizeRenderRequest(params);
        if (!request) throw new Error("render.request requires { target, type, width }");
        return render(request);
      },
      "render.markdown": (params) => {
        const request = sanitizeMarkdownTransformRequest(params);
        if (!request) throw new Error("render.markdown requires { text, messageType }");
        return transformMarkdown(request);
      },
    }),

    dispose() {
      disposeRecords();
      binding = null;
    },
  };
}
