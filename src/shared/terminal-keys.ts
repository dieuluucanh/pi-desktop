/**
 * DOM keyboard events → terminal byte sequences (plan step 17).
 *
 * Pi's TUI components (`Editor`, `SelectList`, `ScrollView`, …) consume raw
 * terminal input through `handleInput(data)` and match it with pi-tui's
 * `matchesKey`. The renderer, however, sees DOM `KeyboardEvent`s. This module is
 * the translation layer: it turns a key event into the byte sequence the
 * component expects, so an extension's `ctx.ui.custom()` component behaves
 * exactly as it does in a terminal.
 *
 * Meta/Cmd combinations return null: they belong to the Electron menu and the
 * OS, never to a terminal component. `tests/shared/terminal-keys.test.ts` pins
 * every entry against pi-tui's own `matchesKey`, so a wrong sequence fails a
 * test instead of silently breaking an extension's key handling.
 *
 * No pi-tui import (the renderer bundle stays free of its Node-only modules).
 */

export interface TerminalKeyInput {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

const ESC = "\x1b";

const NAMED_SEQUENCES: Record<string, string> = {
  escape: `${ESC}`,
  enter: "\r",
  tab: "\t",
  backspace: "\x7f",
  delete: `${ESC}[3~`,
  insert: `${ESC}[2~`,
  home: `${ESC}[H`,
  end: `${ESC}[F`,
  pageup: `${ESC}[5~`,
  pagedown: `${ESC}[6~`,
  arrowup: `${ESC}[A`,
  arrowdown: `${ESC}[B`,
  arrowright: `${ESC}[C`,
  arrowleft: `${ESC}[D`,
  " ": " ",
  f1: `${ESC}OP`,
  f2: `${ESC}OQ`,
  f3: `${ESC}OR`,
  f4: `${ESC}OS`,
  f5: `${ESC}[15~`,
  f6: `${ESC}[17~`,
  f7: `${ESC}[18~`,
  f8: `${ESC}[19~`,
  f9: `${ESC}[20~`,
  f10: `${ESC}[21~`,
  f11: `${ESC}[23~`,
  f12: `${ESC}[24~`,
};

/** Shift/ctrl variants of the functional keys, in pi-tui's legacy spelling. */
const MODIFIED_SEQUENCES: Record<string, string> = {
  "shift+tab": `${ESC}[Z`,
  "shift+enter": `${ESC}[13;2u`,
  "shift+arrowup": `${ESC}[a`,
  "shift+arrowdown": `${ESC}[b`,
  "shift+arrowright": `${ESC}[c`,
  "shift+arrowleft": `${ESC}[d`,
  "alt+arrowup": `${ESC}[1;3A`,
  "alt+arrowdown": `${ESC}[1;3B`,
  "alt+arrowright": `${ESC}[1;3C`,
  "alt+arrowleft": `${ESC}[1;3D`,
  "ctrl+arrowup": `${ESC}Oa`,
  "ctrl+arrowdown": `${ESC}Ob`,
  "ctrl+arrowright": `${ESC}Oc`,
  "ctrl+arrowleft": `${ESC}Od`,
  "ctrl+home": `${ESC}[7^`,
  "ctrl+end": `${ESC}[8^`,
  "ctrl+pageup": `${ESC}[5^`,
  "ctrl+pagedown": `${ESC}[6^`,
  "ctrl+insert": `${ESC}[2^`,
  "ctrl+delete": `${ESC}[3^`,
};

const CTRL_LETTERS = /^[a-z]$/;

function controlByte(char: string): string | null {
  const code = char.toLowerCase().charCodeAt(0);
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  return null;
}

/**
 * The terminal bytes for one key event, or null when the app should ignore it
 * (a Meta/Cmd chord, a bare modifier key, or an unsupported key).
 */
export function domKeyToTerminalData(input: TerminalKeyInput): string | null {
  if (input.metaKey) return null;
  const key = input.key;
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") return null;
  const namedKey = namedKeyOf(key);
  const printable = key.length === 1 ? key.toLowerCase() : null;

  if (input.ctrlKey) {
    if (namedKey !== null) return MODIFIED_SEQUENCES[`ctrl+${namedKey}`] ?? null;
    if (printable === " ") return "\x00";
    if (printable === "[") return `${ESC}`;
    if (printable === "\\") return "\x1c";
    if (printable === "]") return "\x1d";
    if (printable === "^") return "\x1e";
    if (printable === "_") return "\x1f";
    if (printable === "?") return "\x7f";
    if (printable !== null && CTRL_LETTERS.test(printable)) return controlByte(printable);
    return null;
  }

  if (namedKey !== null) {
    if (input.shiftKey) {
      const shifted = MODIFIED_SEQUENCES[`shift+${namedKey}`];
      if (shifted !== undefined) return shifted;
    }
    if (input.altKey) {
      const alt = MODIFIED_SEQUENCES[`alt+${namedKey}`];
      if (alt !== undefined) return alt;
    }
    const sequence = NAMED_SEQUENCES[namedKey] ?? null;
    if (sequence === null) return null;
    return input.altKey ? `${ESC}${sequence}` : sequence;
  }
  // A printable character (the browser already applied Shift).
  if (key.length === 1) return input.altKey ? `${ESC}${key}` : key;
  return null;
}

export interface TerminalWheelInput {
  deltaY: number;
  deltaX?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** Zero-based terminal cell under the pointer. */
  col: number;
  /** Zero-based terminal cell under the pointer. */
  row: number;
}

/**
 * A DOM wheel event as the SGR mouse wheel sequence a TUI component parses.
 *
 * Pi's terminal components that scroll by wheel (the workflow questionnaire is
 * the case in the wild) read raw `\x1b[<64;x;yM` / `65` sequences. A browser
 * wheel has no terminal cell, so the caller supplies the pointer's cell inside
 * the surface. Horizontal, Ctrl (zoom) and Meta wheels return null: those belong
 * to the browser/OS, not to the extension.
 */
export function domWheelToTerminalData(input: TerminalWheelInput): string | null {
  if (input.ctrlKey || input.metaKey) return null;
  if (!Number.isFinite(input.deltaY) || input.deltaY === 0) return null;
  const button = input.deltaY < 0 ? 64 : 65;
  const col = Math.max(0, Math.floor(input.col)) + 1;
  const row = Math.max(0, Math.floor(input.row)) + 1;
  return `${ESC}[<${button};${col};${row}M`;
}

function namedKeyOf(key: string): string | null {
  switch (key) {
    case " ":
      return " ";
    case "ArrowUp":
      return "arrowup";
    case "ArrowDown":
      return "arrowdown";
    case "ArrowLeft":
      return "arrowleft";
    case "ArrowRight":
      return "arrowright";
    case "Escape":
      return "escape";
    case "Enter":
      return "enter";
    case "Tab":
      return "tab";
    case "Backspace":
      return "backspace";
    case "Delete":
      return "delete";
    case "Insert":
      return "insert";
    case "Home":
      return "home";
    case "End":
      return "end";
    case "PageUp":
      return "pageup";
    case "PageDown":
      return "pagedown";
    default:
      return key.length > 1 && /^F\d{1,2}$/.test(key) ? key.toLowerCase() : null;
  }
}

/** Bracketed-paste framing so a custom editor applies its paste handling. */
export function bracketedPaste(text: string): string {
  return `${ESC}[200~${text}${ESC}[201~`;
}

/**
 * Integrated-terminal key ownership (2026-11-05 native-terminal plan, step 2).
 *
 * An embedded terminal must not steal the shell's keys. VSCode solves this with
 * `terminal.integrated.commandsToSkipShell`: a curated allowlist of app commands
 * whose shortcuts still fire while the terminal has focus; everything else is
 * sent to the PTY. This module is that policy, as a pure table so it can be
 * tested without a DOM or a shell.
 *
 * The renderer feeds the decision into xterm's `attachCustomKeyEventHandler`:
 * `pty` lets xterm encode the key natively (correct for IME, Alt-as-Meta and
 * every VT sequence), `app` performs the action and returns `false`, and
 * `ignore` returns `false` so the OS/menu keeps the chord.
 *
 * Menu accelerators are suppressed by main while a terminal has focus on
 * Windows/Linux (`setIgnoreMenuShortcuts`), which is why the shell-modifier
 * chords below can reach the PTY at all. On macOS the menu accelerators are
 * Cmd-based and never collide with the shell's Ctrl keys.
 */

export type TerminalKeyPlatform = "win32" | "darwin" | "linux";

export type TerminalAppAction =
  | "copy"
  | "paste"
  | "select-all"
  | "find"
  | "clear"
  | "new-terminal"
  | "close-terminal"
  | "toggle-terminal"
  | "next-tab"
  | "previous-tab"
  | "command-palette"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset";

export interface TerminalKeyContext {
  platform: TerminalKeyPlatform;
  /** A selection exists in the terminal buffer. */
  hasSelection: boolean;
  /** The `copyOnSelection` preference: Ctrl+C copies instead of sending SIGINT. */
  copyOnSelection: boolean;
}

export type TerminalKeyDecision =
  { kind: "app"; action: TerminalAppAction } | { kind: "pty" } | { kind: "ignore" };

const PTY: TerminalKeyDecision = { kind: "pty" };
const IGNORE: TerminalKeyDecision = { kind: "ignore" };

function app(action: TerminalAppAction): TerminalKeyDecision {
  return { kind: "app", action };
}

/**
 * Decides who owns one key event while a terminal has focus.
 *
 * Defaults to the PTY: ordinary typing, Tab completion, Esc, Ctrl+C (SIGINT),
 * Ctrl+D/Z/L/N/P/B/G and every Ctrl+Shift combination we do not claim all reach
 * the shell. Only the curated chords below are app actions.
 */
export function terminalKeyDecision(
  input: TerminalKeyInput,
  context: TerminalKeyContext,
): TerminalKeyDecision {
  const mac = context.platform === "darwin";
  const key = input.key;
  // Named keys are matched case-insensitively (`Tab`, `Insert`, `F1`), and a
  // single character is lowercased so Shift+C still reads as the copy chord.
  const lower = key.toLowerCase();

  // The Windows/Alt/Win key is the OS's; never hand it to a shell.
  if (input.metaKey && !mac) return IGNORE;
  // Alt is xterm's concern (macOptionIsMeta / compose).
  if (input.altKey) return PTY;

  if (input.metaKey) {
    switch (lower) {
      case "c":
        return app("copy");
      case "v":
        return app("paste");
      case "a":
        return app("select-all");
      case "f":
        return app("find");
      case "k":
        return app("clear");
      case "w":
        return app("close-terminal");
      case "`":
        return input.shiftKey ? app("new-terminal") : app("toggle-terminal");
      case "=":
      case "+":
        return app("zoom-in");
      case "-":
      case "_":
        return app("zoom-out");
      case "0":
        return app("zoom-reset");
      case "p":
        return input.shiftKey ? app("command-palette") : IGNORE;
      default:
        // Cmd+N / Cmd+Q / Cmd+R and friends stay with the menu and the OS.
        return IGNORE;
    }
  }

  if (!input.ctrlKey) {
    // Shift+Insert is the Windows/Linux paste convention.
    return input.shiftKey && lower === "insert" ? app("paste") : PTY;
  }

  if (lower === "tab") return input.shiftKey ? app("previous-tab") : app("next-tab");
  if (lower === "`") return input.shiftKey ? app("new-terminal") : app("toggle-terminal");

  if (input.shiftKey) {
    switch (lower) {
      case "c":
        return app("copy");
      case "v":
        return app("paste");
      case "f":
        return app("find");
      case "p":
        return app("command-palette");
      case "k":
        return app("clear");
      default:
        return PTY;
    }
  }

  if (!mac) {
    switch (lower) {
      case "insert":
        return app("copy");
      case "v":
        return app("paste");
      case "w":
        return app("close-terminal");
      case "=":
      case "+":
        return app("zoom-in");
      case "-":
      case "_":
        return app("zoom-out");
      case "0":
        return app("zoom-reset");
      case "c":
        // VSCode's rule: copy only when the selection is there to copy.
        return context.hasSelection && context.copyOnSelection ? app("copy") : PTY;
      default:
        return PTY;
    }
  }

  return context.hasSelection && context.copyOnSelection && lower === "c" ? app("copy") : PTY;
}
