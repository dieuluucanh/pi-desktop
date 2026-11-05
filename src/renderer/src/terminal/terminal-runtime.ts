/**
 * The renderer terminal runtime singleton (2026-11-05 native-terminal plan,
 * step 9).
 *
 * One xterm pool and one terminal store per renderer, shared by every terminal
 * view (the solo tab and each grid pane). The bridge is read lazily so importing
 * this module never touches `window.pi`; tests inject their own store/pool
 * instead of using this singleton.
 */

import { useStore } from "zustand";
import type { TerminalBridge } from "../../../shared/terminal-ipc";
import {
  DEFAULT_TERMINAL_PREFS,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  type TerminalCursorStyle,
} from "../../../shared/terminal-prefs";
import { terminalThemeFromCssVariables } from "../../../shared/terminal-theme";
import type { TerminalKeyPlatform } from "../../../shared/terminal-keys";
import { terminalFontFamilyFromDocument } from "./terminal-font";
import {
  createTerminalStore,
  type TerminalStore,
  type TerminalStoreState,
} from "../state/terminal-store";
import { createTerminalEventPump, type TerminalEventPump } from "./terminal-controller";
import { TerminalPool, type TerminalPoolOptions } from "./terminal-pool";
import { createXtermFactory } from "./xterm-factory";

interface RuntimeConfig {
  fontSize: number;
  fontFamily: string | null;
  scrollback: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  macOptionIsMeta: boolean;
  copyOnSelection: boolean;
  enableBell: boolean;
  platform: TerminalKeyPlatform;
  /** Opens the project-trust prompt; the view's Retry button decides the grant. */
  requestTrust: (cwd: string) => Promise<boolean>;
}

const config: RuntimeConfig = {
  fontSize: DEFAULT_TERMINAL_PREFS.fontSize,
  fontFamily: DEFAULT_TERMINAL_PREFS.fontFamily,
  scrollback: DEFAULT_TERMINAL_PREFS.scrollback,
  cursorStyle: DEFAULT_TERMINAL_PREFS.cursorStyle,
  cursorBlink: DEFAULT_TERMINAL_PREFS.cursorBlink,
  macOptionIsMeta: DEFAULT_TERMINAL_PREFS.macOptionIsMeta,
  copyOnSelection: DEFAULT_TERMINAL_PREFS.copyOnSelection,
  enableBell: DEFAULT_TERMINAL_PREFS.enableBell,
  platform:
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
      ? "darwin"
      : typeof navigator !== "undefined" && /Win/i.test(navigator.platform)
        ? "win32"
        : "linux",
  requestTrust: async () => false,
};

let runtimeTheme = terminalThemeFromCssVariables(() => "");

export function configureTerminalRuntime(next: Partial<RuntimeConfig>): void {
  Object.assign(config, next);
}

/** Re-reads the app-wide CSS tokens; call on mount and on a theme change. */
export function refreshTerminalTheme(): void {
  if (typeof document === "undefined") return;
  const styles = getComputedStyle(document.documentElement);
  runtimeTheme = terminalThemeFromCssVariables((name) => styles.getPropertyValue(name));
  terminalPool.setTheme(runtimeTheme);
  // A theme can also change typography tokens; re-resolve the concrete family
  // instead of leaving a live xterm on the previous stack.
  terminalPool.setOptions({ fontFamily: terminalFontFamilyFromDocument(config.fontFamily) });
}

export function runtimeOptions(cols: number, rows: number): TerminalPoolOptions {
  return {
    cols,
    rows,
    fontSize: clampFontSize(config.fontSize),
    fontFamily: terminalFontFamilyFromDocument(config.fontFamily),
    scrollback: config.scrollback,
    cursorStyle: config.cursorStyle,
    cursorBlink: config.cursorBlink,
    macOptionIsMeta: config.macOptionIsMeta,
    theme: runtimeTheme,
  };
}

export function clampFontSize(size: number): number {
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(size)));
}

export function terminalRuntimeConfig(): Readonly<RuntimeConfig> {
  return config;
}

function bridge(): TerminalBridge {
  const api = window.pi;
  if (!api?.terminal) throw new Error("The terminal bridge is unavailable.");
  return api.terminal;
}

/** A lazily-resolved bridge so importing this module has no side effects. */
const lazyBridge: TerminalBridge = {
  create: (input) => bridge().create(input),
  attach: (terminalId) => bridge().attach(terminalId),
  write: (terminalId, data) => bridge().write(terminalId, data),
  resize: (terminalId, cols, rows) => bridge().resize(terminalId, cols, rows),
  close: (terminalId) => bridge().close(terminalId),
  ack: (terminalId, bytes) => bridge().ack(terminalId, bytes),
  list: () => bridge().list(),
  profiles: (force) => bridge().profiles(force),
  setFocus: (focused) => bridge().setFocus(focused),
  onEvent: (listener) => bridge().onEvent(listener),
};

export const terminalPool = new TerminalPool(createXtermFactory());

export const terminalStore: TerminalStore = createTerminalStore({
  bridge: lazyBridge,
  pool: terminalPool,
  options: runtimeOptions,
  requestTrust: (cwd) => config.requestTrust(cwd),
  log: (line) => console.warn(line),
});

export const useTerminalStore = <T>(selector: (state: TerminalStoreState) => T): T =>
  useStore(terminalStore, selector);

let pump: TerminalEventPump | null = null;

/**
 * Subscribes to the bridge's event channel on first use. Importing this module
 * must not touch `window.pi` (the renderer test environment has no preload), so
 * the subscription is created when the first view mounts, not at module load.
 */
export function ensureTerminalEventPump(): TerminalEventPump {
  pump ??= createTerminalEventPump(lazyBridge, {
    data: (terminalId, bytes, seq) => terminalStore.getState().handleData(terminalId, bytes, seq),
    exit: (terminalId, exitCode, signal) =>
      terminalStore.getState().handleExit(terminalId, exitCode, signal),
    error: (terminalId, message) => terminalStore.getState().handleError(terminalId, message),
  });
  return pump;
}
