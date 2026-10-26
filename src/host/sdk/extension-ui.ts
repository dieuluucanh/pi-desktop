/**
 * The SDK side of the extension-UI host (plan step 16).
 *
 * `src/host/extension-ui.ts` owns all the state and speaks the wire protocol;
 * this adapter is the only place that turns that state into Pi's real
 * `ExtensionUIContext` and binds it to a live `AgentSession`. That keeps every
 * `@earendil-works/*` import inside `src/host/sdk/*` (AGENTS.md rule 4).
 *
 * The TUI rendering surface (`custom`, `setFooter`, `setHeader`,
 * `onTerminalInput`) is rendered by the step-17 host. `setEditorComponent` is
 * recorded on the UI port so `getEditorComponent()` stays meaningful for
 * extension-to-extension coordination, but it is deliberately **never mounted**:
 * the desktop always uses its native composer. Pi's interactive mode wires
 * `onSubmit`/`onChange`/autocomplete/action handlers when it installs a custom
 * editor, and the emulated TUI has no equivalent bridge — a mounted editor would
 * accept keystrokes but discard Enter and hide the app's completion. Pi's RPC
 * mode makes the same choice (it ignores custom editors).
 */

import {
  Theme,
  initTheme,
  type AgentSession,
  type AgentSessionRuntime,
  type AutocompleteProviderFactory,
  type ExtensionCommandContextActions,
  type ExtensionError,
  type ExtensionUIContext,
  type ReadonlyFooterDataProvider,
  type TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-tui";
import { BUILTIN_THEME_SWATCHES } from "../../shared/themes";
import {
  SESSION_SHUTDOWN_REQUEST_EVENT,
  type ExtensionCompletionProviderFactory,
} from "../../shared/extension-ui";
import type { ExtensionTerminalInputHandler, ExtensionUiPort } from "../extension-ui";
import type { ExtensionRendererPort } from "../extension-renderers";
import type { TuiSurfacePort } from "../tui-surface";
import { createSdkFooterData, createSdkTuiKeybindings } from "./tui-surface";

/**
 * Pi installs the active theme on this well-known global symbol
 * (`theme.js` → `Symbol.for(...)`). The SDK exports `initTheme`/`Theme` but not
 * the `theme` proxy, so reading the global is the only way to hand an extension
 * the *current* `Theme` object. `tests/host/sdk-extension-ui.test.ts` pins the
 * symbol: if upstream renames it, the test fails instead of extensions silently
 * getting a fallback.
 */
export const THEME_GLOBAL_SYMBOL = Symbol.for("@earendil-works/pi-coding-agent:theme");

function globalTheme(): Theme | undefined {
  const value = (globalThis as Record<symbol, unknown>)[THEME_GLOBAL_SYMBOL];
  return value instanceof Theme ? value : undefined;
}

const REQUIRED_FG = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
] as const;

const REQUIRED_BG = [
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
] as const;

/**
 * A last-resort theme for the impossible case where `initTheme` could not
 * install one (SDK drift). Built from the pinned dark swatches so
 * `ctx.ui.theme.fg("accent", …)` still works.
 */
function fallbackTheme(): Theme {
  const swatches: Record<string, string | undefined> = BUILTIN_THEME_SWATCHES.dark ?? {};
  const fg: Record<string, string> = {};
  for (const key of REQUIRED_FG) fg[key] = swatches[key] ?? swatches.text ?? "#d4d4d4";
  const bg: Record<string, string> = {};
  for (const key of REQUIRED_BG) bg[key] = swatches.surface ?? "#1e1e24";
  return new Theme(fg as never, bg as never, "truecolor", { name: "dark" });
}

export interface SdkThemeAccess {
  current(): Theme;
  all(): Array<{ name: string; path: string | undefined }>;
  get(name: string): Theme | undefined;
  set(theme: string | Theme): { success: boolean; error?: string };
}

export interface SdkThemeAccessOptions {
  /** The live session (its loader reports user/project themes). */
  session: AgentSession;
  /** Reads and persists the `theme` setting. */
  settings?: { getTheme?(): string | undefined; setTheme?(name: string): void } | null;
}

function loaderThemeInfos(
  session: AgentSession,
): Array<{ name: string; path: string | undefined }> {
  const infos = new Map<string, { name: string; path: string | undefined }>();
  for (const name of ["dark", "light"]) infos.set(name, { name, path: undefined });
  try {
    const themes = session.resourceLoader.getThemes() as { themes?: unknown } | undefined;
    const entries = themes?.themes;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name : undefined;
        if (!name) continue;
        infos.set(name, {
          name,
          path: typeof record.sourcePath === "string" ? record.sourcePath : undefined,
        });
      }
    }
  } catch {
    // A loader that cannot list themes still gets the built-ins.
  }
  return [...infos.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function createSdkThemeAccess(options: SdkThemeAccessOptions): SdkThemeAccess {
  const settings = options.settings ?? null;
  let active = settings?.getTheme?.() ?? "dark";
  initTheme(active);
  if (!globalTheme()) {
    active = "dark";
    initTheme(active);
  }

  const all = (): Array<{ name: string; path: string | undefined }> =>
    loaderThemeInfos(options.session);

  return {
    current: () => globalTheme() ?? fallbackTheme(),
    all,
    get(name) {
      if (!all().some((info) => info.name === name)) return undefined;
      if (name === active) return globalTheme() ?? fallbackTheme();
      // `initTheme` is synchronous; switch, read and restore.
      const previous = active;
      initTheme(name);
      const theme = globalTheme();
      initTheme(previous);
      return theme;
    },
    set(themeOrName) {
      if (themeOrName instanceof Theme) {
        (globalThis as Record<symbol, unknown>)[THEME_GLOBAL_SYMBOL] = themeOrName;
        active = themeOrName.name ?? active;
        return { success: true };
      }
      if (!all().some((info) => info.name === themeOrName)) {
        return { success: false, error: `Unknown theme: ${themeOrName}` };
      }
      initTheme(themeOrName);
      active = themeOrName;
      settings?.setTheme?.(themeOrName);
      return { success: true };
    },
  };
}

/**
 * Wraps the host port in Pi's `ExtensionUIContext`. With a `surface` bundle the
 * TUI members (`custom`, `setFooter`, `setHeader`, `setEditorComponent`) render
 * through the step-17 emulation; without one they stay inert exactly as in
 * step 16 (RPC's own behaviour), so a host that has no surface degrades rather
 * than throwing.
 */
export interface SdkUiSurface {
  port: TuiSurfacePort;
  keybindings: KeybindingsManager;
  footerData: ReadonlyFooterDataProvider;
}

export function createSdkExtensionUiContext(
  port: ExtensionUiPort,
  themeAccess: SdkThemeAccess,
  surface?: SdkUiSurface | null,
): ExtensionUIContext {
  return {
    select: (title, choices, opts) => port.select(title, choices, opts),
    confirm: (title, message, opts) => port.confirm(title, message, opts),
    input: (title, placeholder, opts) => port.input(title, placeholder, opts),
    editor: (title, prefill) => port.editor(title, prefill),
    notify: (message, type) => port.notify(message, type),
    onTerminalInput: (handler: TerminalInputHandler) =>
      port.onTerminalInput(handler as ExtensionTerminalInputHandler),
    setStatus: (key, text) => port.setStatus(key, text),
    setWorkingMessage: (message) => port.setWorkingMessage(message),
    setWorkingVisible: (visible) => port.setWorkingVisible(visible),
    setWorkingIndicator: (indicator) => port.setWorkingIndicator(indicator),
    setHiddenThinkingLabel: (label) => port.setHiddenThinkingLabel(label),
    setWidget(key, content, widgetOptions) {
      const placement = widgetOptions?.placement === "belowEditor" ? "belowEditor" : "aboveEditor";
      if (typeof content === "function") {
        // A component factory renders through the TUI surface; the string form
        // for this key must not linger in `oi.state` (one owner per key).
        port.setWidget(key, undefined, widgetOptions);
        surface?.port.setWidget(
          key,
          (tui) => {
            try {
              return content(tui as never, themeAccess.current() as never) as never;
            } catch {
              // A throwing widget factory must never take the session down; it
              // simply renders nothing, like a throwing footer/header.
              return undefined as never;
            }
          },
          placement,
        );
        return;
      }
      // An array/undefined owns the key: remove any component widget first.
      surface?.port.setWidget(key, undefined, placement);
      port.setWidget(key, content, widgetOptions);
    },
    setFooter: (factory) => {
      port.setFooter(factory);
      surface?.port.setFooter(
        factory
          ? (tui) => factory(tui as never, themeAccess.current(), surface.footerData) as never
          : undefined,
      );
    },
    setHeader: (factory) => {
      port.setHeader(factory);
      surface?.port.setHeader(
        factory ? (tui) => factory(tui as never, themeAccess.current()) as never : undefined,
      );
    },
    setTitle: (title) => port.setTitle(title),
    custom: async <T>(
      factory: Parameters<ExtensionUIContext["custom"]>[0],
      options?: Parameters<ExtensionUIContext["custom"]>[1],
    ): Promise<T> => {
      if (!surface) return undefined as T;
      return surface.port.custom<T>(
        (tui, done) =>
          factory(
            tui as never,
            themeAccess.current(),
            surface.keybindings as never,
            done as never,
          ) as never,
        options,
      );
    },
    pasteToEditor: (text) => port.pasteToEditor(text),
    setEditorText: (text) => port.setEditorText(text),
    getEditorText: () => port.getEditorText(),
    addAutocompleteProvider(factory: AutocompleteProviderFactory) {
      // SAFETY: pi-tui's `AutocompleteProvider` is structurally identical to
      // `ExtensionCompletionProvider` (same fields, same signatures) — the
      // shared type is a deliberate mirror so host evaluation can run it.
      port.addAutocompleteProvider(factory as unknown as ExtensionCompletionProviderFactory);
    },
    setEditorComponent: (factory) => {
      // Record for `getEditorComponent()`/extension coordination, but never
      // construct or mount the component: the desktop keeps its native composer
      // (see the module comment for why).
      port.setEditorComponent(factory);
    },
    getEditorComponent: () =>
      port.getEditorComponent() as Parameters<ExtensionUIContext["setEditorComponent"]>[0],
    get theme() {
      return themeAccess.current();
    },
    getAllThemes: () => themeAccess.all(),
    getTheme: (name) => themeAccess.get(name),
    setTheme: (themeOrName) => {
      const result = themeAccess.set(themeOrName);
      if (result.success) {
        const name = typeof themeOrName === "string" ? themeOrName : (themeOrName.name ?? "");
        if (name) port.emitTheme(name);
        surface?.port.invalidate();
      }
      return result;
    },
    getToolsExpanded: () => port.getToolsExpanded(),
    setToolsExpanded: (expanded) => port.setToolsExpanded(expanded),
  };
}

/** The runtime commands an extension command context needs (plan step 16). */
export function createSdkCommandContextActions(
  session: AgentSession,
  runtime: AgentSessionRuntime,
): ExtensionCommandContextActions {
  return {
    waitForIdle: () => session.waitForIdle(),
    newSession: (options) => runtime.newSession(options),
    fork: (entryId, options) => runtime.fork(entryId, options),
    navigateTree: (targetId, options) => session.navigateTree(targetId, options),
    switchSession: (sessionPath, options) => runtime.switchSession(sessionPath, options),
    reload: () => session.reload(),
  };
}

export interface SdkExtensionBinderOptions {
  port: ExtensionUiPort;
  /** The host's event emitter, so errors and shutdown requests reach the app. */
  emit(event: string, payload?: unknown, sessionId?: string): void;
  /** The step-17 TUI surface; without one the TUI members stay inert. */
  tuiSurface?: TuiSurfacePort | null;
  /**
   * The step-18 renderer registry. A rebind replaces the session's extensions,
   * so the registry is re-pointed at the new runner (and its per-tool renderer
   * state dropped) exactly when the UI context is rebuilt.
   */
  renderers?: ExtensionRendererPort | null;
  /** Reads the profile's `keybindings.json` overrides for the global manager. */
  readKeybindings?: () => Promise<Record<string, unknown>>;
}

/**
 * Builds the `bindSession` callback the session core calls for every session it
 * attaches (create, open, resume and every rebind after a session replacement).
 */
export function createSdkExtensionBinder(
  options: SdkExtensionBinderOptions,
): (session: AgentSession, runtime: AgentSessionRuntime) => Promise<void> {
  return async (session, runtime) => {
    // A rebind replaces the session's extensions: every registration from the
    // previous session (statuses, widgets, working state, title, footer/header/
    // editor factories, terminal-input handlers and autocomplete providers) must
    // be cleared before the new `session_start` runs. Otherwise a stale
    // `getEditorComponent()` makes an extension skip re-installing, and old
    // terminal/autocomplete closures keep firing in the new session.
    options.port.resetSessionUi();
    const settings = session.settingsManager;
    const themeAccess = createSdkThemeAccess({
      session,
      settings: settings
        ? {
            ...(typeof settings.getTheme === "function"
              ? { getTheme: () => settings.getTheme() }
              : {}),
            ...(typeof settings.setTheme === "function"
              ? { setTheme: (name: string) => settings.setTheme(name) }
              : {}),
          }
        : null,
    });
    let surface: SdkUiSurface | null = null;
    if (options.tuiSurface) {
      // A rebind replaces the session's extensions, so the previous surface
      // (footer/custom) must not leak into the new one. The port's editor
      // registration is cleared above and is never mounted anyway.
      options.tuiSurface.reset();
      const user = options.readKeybindings ? await options.readKeybindings().catch(() => ({})) : {};
      surface = {
        port: options.tuiSurface,
        keybindings: createSdkTuiKeybindings(user),
        footerData: createSdkFooterData(options.port),
      };
    }
    // Extension-owned renderers (plan step 18) are re-pointed at the new
    // runner on every rebind, so a `/reload` cannot keep rendering the old
    // extension's components. The theme is read at render time so a switch shows.
    options.renderers?.bind({
      // SAFETY: `RendererRunner` mirrors `ExtensionRunner`'s renderer lookups but
      // widens the payloads to `unknown` (the registry is SDK-free). The SDK's
      // `CustomMessage`/`CustomEntry` are narrower, so the runner is passed as
      // `never` exactly as the other structural adapters do.
      runner: session.extensionRunner as never,
      theme: () => themeAccess.current(),
      cwd: runtime.cwd,
    });
    const uiContext = createSdkExtensionUiContext(options.port, themeAccess, surface);
    await session.bindExtensions({
      uiContext,
      // The TUI surface is real from step 17: reporting `tui` means an extension
      // that branches on mode takes the terminal path, and its components render
      // through the emulation instead of degrading.
      mode: "tui",
      commandContextActions: createSdkCommandContextActions(session, runtime),
      shutdownHandler: () => options.emit(SESSION_SHUTDOWN_REQUEST_EVENT, {}),
      onError: (error: ExtensionError) =>
        options.emit("extension_error", {
          extensionPath: error.extensionPath,
          event: error.event,
          error: error.error,
          ...(error.stack ? { stack: error.stack } : {}),
        }),
    });
  };
}
