import { randomUUID } from "node:crypto";
import {
  EXTENSION_UI_NOTIFY_EVENT,
  EXTENSION_UI_STATE_EVENT,
  EXTENSION_UI_THEME_EVENT,
  SESSION_SHUTDOWN_REQUEST_EVENT,
  applyCompletionInPlace,
  extensionWidgetsByPlacement,
  sanitizeCompletionApplyRequest,
  sanitizeCompletionRequest,
  type ExtensionCompletionItem,
  type ExtensionCompletionProvider,
  type ExtensionCompletionProviderFactory,
  type ExtensionCompletionResult,
  type ExtensionCompletionSuggestions,
  type ExtensionNotifyType,
  type ExtensionUiSnapshot,
  type ExtensionWidgetPlacement,
} from "../shared/extension-ui";
import type { HostMethod } from "../shared/host-protocol";
import type { HostHandler } from "./service";

/**
 * The extension-UI host (plan step 16, half A).
 *
 * Two layers live here:
 *
 * 1. **The request bridge** (`createExtensionUiBridge`): an extension asking
 *    `ctx.ui.select()` blocks until the app answers `oi.respond` with the same
 *    id — the same request/response shape Pi's RPC mode uses.
 * 2. **The UI port** (`createExtensionUiPort`): the stateful half — statuses,
 *    widgets, working state, the composer mirror and extension autocomplete
 *    providers. It answers `oi.state`/`oi.editorText`/`completion.suggest`/
 *    `completion.apply` and pushes an `oi.state` snapshot after every change, so
 *    the renderer never reconciles partial updates.
 *
 * The port is SDK-free: the actual `ExtensionUIContext` object (which needs Pi's
 * `Theme`) is assembled in `src/host/sdk/extension-ui.ts`, keeping every
 * `@earendil-works/*` import inside `src/host/sdk/*` (AGENTS.md rule 4).
 */

export interface PendingUiRequest {
  id: string;
  method: string;
  params?: unknown;
}

export interface UiResponse {
  id: string;
  value?: unknown;
  confirmed?: boolean;
  cancelled?: boolean;
}

export interface ExtensionUiBridge {
  /**
   * Registers a request, emits `oi.request`, resolves on `oi.respond`.
   * `onId` receives the minted id synchronously so a caller that can retract the
   * visible dialog (`opts.signal`) knows what to cancel.
   */
  request(method: string, params?: unknown, onId?: (id: string) => void): Promise<unknown>;
  /** Outstanding request ids (diagnostics and tests). */
  pendingIds(): string[];
  /** Rejects every pending request, e.g. when its session goes away. */
  dispose(reason: string): void;
  handlers(): Partial<Record<HostMethod, HostHandler>>;
}

export interface ExtensionUiOptions {
  /** Pushes the `oi.request` event to the app. */
  emit(event: string, payload?: unknown): void;
  newId?: () => string;
  /** How long a dialog may stay unanswered before the extension is unblocked. */
  timeoutMs?: number;
}

export const DEFAULT_UI_TIMEOUT_MS = 5 * 60_000;

interface Deferred {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

function parseResponse(params: unknown): UiResponse | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  return {
    id: record.id,
    ...("value" in record ? { value: record.value } : {}),
    ...(typeof record.confirmed === "boolean" ? { confirmed: record.confirmed } : {}),
    ...(record.cancelled === true ? { cancelled: true } : {}),
  };
}

export function createExtensionUiBridge(options: ExtensionUiOptions): ExtensionUiBridge {
  const pending = new Map<string, Deferred>();
  const newId = options.newId ?? ((): string => randomUUID());
  const timeoutMs = options.timeoutMs ?? DEFAULT_UI_TIMEOUT_MS;

  const cancel = (id: string): void => {
    // A dialog may already be gone in the renderer; the event is idempotent.
    options.emit("oi.cancel", { id });
  };

  const settle = (id: string): Deferred | undefined => {
    const entry = pending.get(id);
    if (!entry) return undefined;
    pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
  };

  return {
    request(method, params, onId) {
      const id = newId();
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          // The app never answered: unblock the extension instead of hanging the
          // session, and let step 16 decide how to surface the miss.
          settle(id)?.reject(new Error(`extension UI request ${method} timed out`));
        }, timeoutMs);
        if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
        pending.set(id, { resolve, reject, timer });
        onId?.(id);
        options.emit("oi.request", { id, method, params });
      });
    },

    pendingIds: () => [...pending.keys()],

    dispose(reason) {
      for (const id of [...pending.keys()]) {
        // The renderer must not keep a dialog the extension can no longer hear:
        // retract it in the same step that rejects the host promise.
        cancel(id);
        settle(id)?.reject(new Error(reason));
      }
    },

    handlers: () => ({
      "oi.respond": (params) => {
        const response = parseResponse(params);
        if (!response) {
          throw new Error("oi.respond requires an { id } envelope");
        }
        const entry = settle(response.id);
        if (!entry) return { delivered: false };
        if (response.cancelled === true) entry.resolve(undefined);
        else if (typeof response.confirmed === "boolean") entry.resolve(response.confirmed);
        else entry.resolve(response.value);
        return { delivered: true };
      },
    }),
  };
}

/* ------------------------------------------------------------------------- *
 * The UI port
 * ------------------------------------------------------------------------- */

/** `ExtensionUIDialogOptions`, structurally (no SDK import). */
export interface ExtensionDialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface ExtensionWorkingIndicatorOptions {
  frames?: string[];
  intervalMs?: number;
}

export interface ExtensionWidgetOptions {
  placement?: ExtensionWidgetPlacement;
}

/**
 * An opaque TUI component factory (`setFooter`/`setHeader`/`setEditorComponent`).
 * The desktop renders footers/headers; an editor factory is only recorded for
 * `getEditorComponent()` coordination and is never mounted (the native composer
 * is always the editor), so the type stays structural and carries no SDK import.
 */
export type ExtensionTuiFactory = (...args: never[]) => object;

/**
 * `TerminalInputHandler`, structurally: step 17 feeds raw key data through it.
 */
export type ExtensionTerminalInputHandler = (
  data: string,
) => { consume?: boolean; data?: string } | undefined;

export interface ExtensionUiPortOptions {
  emit(event: string, payload?: unknown): void;
  newId?: () => string;
  /**
   * Mints the composer "binding" id stamped on every editor command (plan step
   * 17). The renderer fences sequence numbers per binding, so a rebound host's
   * sequence restart cannot be mistaken for a stale repeat. Defaults to a random
   * UUID per port and per rebind.
   */
  newBindingId?: () => string;
  timeoutMs?: number;
  now?: () => number;
}

export interface ExtensionUiPort {
  // Dialogs (request/response through the bridge).
  select(
    title: string,
    options: string[],
    opts?: ExtensionDialogOptions,
  ): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: ExtensionDialogOptions): Promise<boolean>;
  input(
    title: string,
    placeholder?: string,
    opts?: ExtensionDialogOptions,
  ): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;

  // Fire-and-forget state.
  notify(message: string, type?: ExtensionNotifyType): void;
  setStatus(key: string, text: string | undefined): void;
  setWorkingMessage(message?: string): void;
  setWorkingVisible(visible: boolean): void;
  setWorkingIndicator(options?: ExtensionWorkingIndicatorOptions): void;
  setHiddenThinkingLabel(label?: string): void;
  setWidget(key: string, lines: string[] | undefined, options?: ExtensionWidgetOptions): void;
  setTitle(title: string): void;
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;

  // Composer mirror.
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;

  // Step 17 surfaces. `custom`/footer/header render through the TUI host; the
  // editor registration is recorded but never mounted (note on the factory type).
  onTerminalInput(handler: ExtensionTerminalInputHandler): () => void;
  terminalInputHandlers(): readonly ExtensionTerminalInputHandler[];
  custom(): Promise<undefined>;
  setFooter(factory: ExtensionTuiFactory | undefined): void;
  setHeader(factory: ExtensionTuiFactory | undefined): void;
  getFooter(): ExtensionTuiFactory | undefined;
  getHeader(): ExtensionTuiFactory | undefined;
  setEditorComponent(factory: ExtensionTuiFactory | undefined): void;
  getEditorComponent(): ExtensionTuiFactory | undefined;

  // Extension autocomplete providers (run in the host).
  addAutocompleteProvider(factory: ExtensionCompletionProviderFactory): void;
  providerCount(): number;

  // Theme (the SDK adapter emits when an extension switches).
  emitTheme(name: string): void;

  // Lifecycle.
  snapshot(): ExtensionUiSnapshot;
  /**
   * Clears every registration an extension made for this session (statuses,
   * widgets, working state, hidden-thinking label, title, footer/header/editor
   * factories, terminal-input handlers and autocomplete providers) and pushes
   * one empty state. App-owned state (`toolsExpanded`) and the renderer-owned
   * composer text mirror survive; a rebind replaces the session's extensions.
   */
  resetSessionUi(): void;
  handlers(): Partial<Record<HostMethod, HostHandler>>;
  dispose(reason: string): void;
}

function editorCommandFrom(
  seq: number,
  text: string,
  binding: string,
): { seq: number; text: string; binding: string } {
  return { seq, text, binding };
}

export function createExtensionUiPort(options: ExtensionUiPortOptions): ExtensionUiPort {
  const now = options.now ?? ((): number => Date.now());
  const bridge = createExtensionUiBridge({
    emit: options.emit,
    ...(options.newId ? { newId: options.newId } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  const statuses = new Map<string, string>();
  const widgets = new Map<string, { lines: string[]; placement: ExtensionWidgetPlacement }>();
  const providers: ExtensionCompletionProviderFactory[] = [];
  const terminalInput = new Set<ExtensionTerminalInputHandler>();
  let working: ExtensionUiSnapshot["working"] = {
    message: null,
    visible: null,
    frames: null,
    intervalMs: null,
  };
  let hiddenThinkingLabel: string | null = null;
  let title: string | null = null;
  let toolsExpanded: boolean | null = null;
  let editorText = "";
  let editorSeq = 0;
  let editorBinding = (options.newBindingId ?? ((): string => `extui-${randomUUID()}`))();
  let editorCommand: ExtensionUiSnapshot["editor"] = null;
  let footerFactory: ExtensionTuiFactory | undefined;
  let headerFactory: ExtensionTuiFactory | undefined;
  let editorComponentFactory: ExtensionTuiFactory | undefined;

  const snapshot = (): ExtensionUiSnapshot => ({
    statuses: Object.fromEntries(statuses),
    widgets: [...widgets.entries()].map(([key, value]) => ({
      key,
      lines: [...value.lines],
      placement: value.placement,
    })),
    working: { ...working },
    hiddenThinkingLabel,
    title,
    toolsExpanded,
    autocompleteProviders: providers.length,
    editor: editorCommand,
  });

  const pushState = (): void => {
    options.emit(EXTENSION_UI_STATE_EVENT, snapshot());
  };

  const dialog = (
    method: string,
    params: Record<string, unknown>,
    opts: ExtensionDialogOptions | undefined,
    defaultValue: unknown,
  ): Promise<unknown> => {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
    let requestId: string | null = null;
    const request = bridge.request(
      method,
      {
        ...params,
        ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }),
      },
      (id) => {
        requestId = id;
      },
    );
    if (!opts?.signal) return request;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        // Retract the visible dialog too: the extension no longer waits for it,
        // so it must not stay on screen until the store timeout (row 28).
        if (requestId) options.emit("oi.cancel", { id: requestId });
        resolve(defaultValue);
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      request.then(
        (value) => {
          opts.signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          opts.signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  };

  const buildProviderChain = (base: ExtensionCompletionSuggestions | null) => {
    const proxyBase: ExtensionCompletionProvider = {
      triggerCharacters: ["/", "@", "#"],
      async getSuggestions() {
        return base;
      },
      applyCompletion: applyCompletionInPlace,
      shouldTriggerFileCompletion: () => true,
    };
    let current: ExtensionCompletionProvider = proxyBase;
    for (const factory of providers) {
      const next = factory(current);
      if (next) current = next;
    }
    return current;
  };

  return {
    select: (title, choices, opts) =>
      dialog("select", { title, options: choices }, opts, undefined).then((value) =>
        typeof value === "string" ? value : undefined,
      ),
    confirm: (title, message, opts) =>
      dialog("confirm", { title, message }, opts, false).then((value) => value === true),
    input: (title, placeholder, opts) =>
      dialog(
        "input",
        { title, ...(placeholder === undefined ? {} : { placeholder }) },
        opts,
        undefined,
      ).then((value) => (typeof value === "string" ? value : undefined)),
    editor: (title, prefill) =>
      dialog(
        "editor",
        { title, ...(prefill === undefined ? {} : { prefill }) },
        undefined,
        undefined,
      ).then((value) => (typeof value === "string" ? value : undefined)),

    notify(message, type) {
      options.emit(EXTENSION_UI_NOTIFY_EVENT, {
        id: options.newId?.() ?? randomUUID(),
        message,
        type: type ?? "info",
        at: now(),
      });
    },

    setStatus(key, text) {
      if (text === undefined) statuses.delete(key);
      else statuses.set(key, text);
      pushState();
    },

    setWorkingMessage(message) {
      working = { ...working, message: message ?? null };
      pushState();
    },
    setWorkingVisible(visible) {
      working = { ...working, visible };
      pushState();
    },
    setWorkingIndicator(indicator) {
      working = {
        ...working,
        frames: indicator?.frames ? [...indicator.frames] : null,
        intervalMs: indicator?.intervalMs ?? null,
      };
      pushState();
    },
    setHiddenThinkingLabel(label) {
      hiddenThinkingLabel = label ?? null;
      pushState();
    },
    setWidget(key, lines, widgetOptions) {
      if (lines === undefined) widgets.delete(key);
      else
        widgets.set(key, {
          lines: [...lines],
          placement: widgetOptions?.placement ?? "aboveEditor",
        });
      pushState();
    },
    setTitle(next) {
      title = next;
      pushState();
    },
    getToolsExpanded: () => toolsExpanded ?? false,
    setToolsExpanded(expanded) {
      toolsExpanded = expanded;
      pushState();
    },

    pasteToEditor(text) {
      editorText = `${editorText}${text}`;
      editorCommand = editorCommandFrom(++editorSeq, editorText, editorBinding);
      pushState();
    },
    setEditorText(text) {
      // Deliberately unconditional: `ctx.ui.setEditorText` is documented as a
      // plain buffer write for every extension. Fencing lives on the renderer's
      // side (binding + sequence), never in this write itself (plan step 17).
      editorText = text;
      editorCommand = editorCommandFrom(++editorSeq, editorText, editorBinding);
      pushState();
    },
    getEditorText: () => editorText,

    onTerminalInput(handler) {
      terminalInput.add(handler);
      return () => terminalInput.delete(handler);
    },
    terminalInputHandlers: () => [...terminalInput],
    custom: async () => undefined,
    setFooter(factory) {
      footerFactory = factory;
    },
    setHeader(factory) {
      headerFactory = factory;
    },
    getFooter: () => footerFactory,
    getHeader: () => headerFactory,
    setEditorComponent(factory) {
      editorComponentFactory = factory;
    },
    getEditorComponent: () => editorComponentFactory,

    addAutocompleteProvider(factory) {
      providers.push(factory);
      pushState();
    },
    providerCount: () => providers.length,

    emitTheme(name) {
      options.emit(EXTENSION_UI_THEME_EVENT, { name });
    },

    resetSessionUi() {
      // A dialog belongs to the outgoing session. Reject it now instead of
      // leaving the extension blocked for five minutes and letting its answer
      // arrive in the replacement session.
      bridge.dispose("the session was replaced");
      statuses.clear();
      widgets.clear();
      working = { message: null, visible: null, frames: null, intervalMs: null };
      hiddenThinkingLabel = null;
      title = null;
      footerFactory = undefined;
      headerFactory = undefined;
      editorComponentFactory = undefined;
      terminalInput.clear();
      providers.length = 0;
      // `toolsExpanded` is app-owned (Ctrl+O) and `editorText` is the renderer's
      // draft mirror; neither belongs to the outgoing extension session. The
      // *pending* editor command does: replaying it into the replacement session
      // would overwrite a newer draft, so the rebind supersedes it and mints a
      // new binding with a fresh sequence (plan step 17).
      editorBinding = (options.newBindingId ?? ((): string => `extui-${randomUUID()}`))();
      editorSeq = 0;
      editorCommand = null;
      pushState();
    },

    snapshot,
    dispose: (reason) => bridge.dispose(reason),

    handlers: () => ({
      ...bridge.handlers(),
      "oi.state": () => snapshot(),
      "oi.setToolsExpanded": (params: unknown) => {
        // The app owns Ctrl+O; this keeps the host's copy of the expand state
        // truthful for `ctx.ui.getToolsExpanded()` (plan step 18).
        const record =
          params && typeof params === "object" ? (params as Record<string, unknown>) : {};
        if (typeof record.expanded !== "boolean") {
          throw new Error("oi.setToolsExpanded requires { expanded: boolean }");
        }
        toolsExpanded = record.expanded;
        pushState();
        return { ok: true };
      },
      "oi.editorText": (params) => {
        const record =
          params && typeof params === "object" ? (params as Record<string, unknown>) : {};
        if (typeof record.text === "string") {
          editorText = record.text;
          // The mirror is the composer's truth. A pending command that no longer
          // matches it was overwritten by the user (or belongs to an older
          // renderer draft), so keeping it would replay stale text on the next
          // state frame. The mirror itself is never rolled back (plan step 17).
          if (editorCommand !== null && editorCommand.text !== editorText) {
            editorCommand = null;
          }
        }
        return { ok: true };
      },
      "oi.editorConsumed": (params) => {
        // The renderer consumed one command (applied it, or recognised it as a
        // repeat). Clearing it makes delivery strictly one-shot: a reconnected
        // or reloaded renderer cannot be handed the same edit again. A mismatched
        // ack is a no-op so a late ack cannot drop a newer command.
        const record =
          params && typeof params === "object" ? (params as Record<string, unknown>) : {};
        const binding = typeof record.binding === "string" ? record.binding : null;
        const seq = typeof record.seq === "number" ? record.seq : null;
        const matches =
          editorCommand !== null &&
          seq !== null &&
          editorCommand.seq === seq &&
          (binding === null || editorCommand.binding === binding);
        if (matches) editorCommand = null;
        return { ok: true, cleared: matches };
      },
      "completion.suggest": async (params) => {
        const request = sanitizeCompletionRequest(params);
        if (!request)
          throw new Error("completion.suggest requires { lines, cursorLine, cursorCol }");
        if (providers.length === 0) return null;
        const controller = new AbortController();
        const chain = buildProviderChain(request.base);
        const suggestions = await chain.getSuggestions(
          request.lines,
          request.cursorLine,
          request.cursorCol,
          { signal: controller.signal, ...(request.force ? { force: true } : {}) },
        );
        if (!suggestions || suggestions.items.length === 0) return null;
        return suggestions;
      },
      "completion.apply": (params) => {
        const request = sanitizeCompletionApplyRequest(params);
        if (!request)
          throw new Error(
            "completion.apply requires { lines, cursorLine, cursorCol, item, prefix }",
          );
        const chain = buildProviderChain(null);
        const item: ExtensionCompletionItem = request.item;
        const result: ExtensionCompletionResult = chain.applyCompletion(
          request.lines,
          request.cursorLine,
          request.cursorCol,
          item,
          request.prefix,
        );
        return result;
      },
    }),
  };
}

/**
 * The widget lines for a placement, already sanitized by the renderer. Exposed
 * so a test can assert placement filtering without importing the shared module
 * twice.
 */
export function widgetsForPlacement(
  snapshot: ExtensionUiSnapshot,
  placement: ExtensionWidgetPlacement,
): string[][] {
  return extensionWidgetsByPlacement(snapshot, placement).map((widget) => widget.lines);
}

/** The shutdown event name, re-exported so the composition root and tests share it. */
export { SESSION_SHUTDOWN_REQUEST_EVENT, EXTENSION_UI_STATE_EVENT, EXTENSION_UI_THEME_EVENT };
