import { describe, expect, it } from "vitest";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  bracketedPaste,
  domKeyToTerminalData,
  domWheelToTerminalData,
  terminalKeyDecision,
  type TerminalKeyContext,
} from "../../src/shared/terminal-keys";

/**
 * DOM keys → terminal bytes (plan step 17).
 *
 * Every mapping is pinned against pi-tui's own matcher: `matchesKey(bytes, id)`
 * must be true for the chord we claim the bytes represent. That keeps a
 * component's `handleInput` working without a terminal attached.
 */

describe("domKeyToTerminalData", () => {
  const cases: Array<[string, Parameters<typeof domKeyToTerminalData>[0], string]> = [
    ["plain letter", { key: "a" }, "a"],
    ["shifted letter", { key: "A", shiftKey: true }, "shift+a"],
    ["enter", { key: "Enter" }, "enter"],
    ["shift+enter", { key: "Enter", shiftKey: true }, "shift+enter"],
    ["escape", { key: "Escape" }, "escape"],
    ["tab", { key: "Tab" }, "tab"],
    ["shift+tab", { key: "Tab", shiftKey: true }, "shift+tab"],
    ["backspace", { key: "Backspace" }, "backspace"],
    ["delete", { key: "Delete" }, "delete"],
    ["up", { key: "ArrowUp" }, "up"],
    ["down", { key: "ArrowDown" }, "down"],
    ["left", { key: "ArrowLeft" }, "left"],
    ["right", { key: "ArrowRight" }, "right"],
    ["shift+up", { key: "ArrowUp", shiftKey: true }, "shift+up"],
    ["ctrl+up", { key: "ArrowUp", ctrlKey: true }, "ctrl+up"],
    ["home", { key: "Home" }, "home"],
    ["end", { key: "End" }, "end"],
    ["pageUp", { key: "PageUp" }, "pageUp"],
    ["pageDown", { key: "PageDown" }, "pageDown"],
    ["f1", { key: "F1" }, "f1"],
    ["f12", { key: "F12" }, "f12"],
    ["space", { key: " " }, "space"],
    ["ctrl+c", { key: "c", ctrlKey: true }, "ctrl+c"],
    ["ctrl+g", { key: "g", ctrlKey: true }, "ctrl+g"],
    ["alt+b", { key: "b", altKey: true }, "alt+b"],
    ["alt+left", { key: "ArrowLeft", altKey: true }, "alt+left"],
  ];

  it.each(cases)("%s", (_label, input, keyId) => {
    const bytes = domKeyToTerminalData(input);
    expect(bytes).not.toBeNull();
    expect(matchesKey(bytes as string, keyId as never)).toBe(true);
  });

  it("ignores Meta chords and bare modifiers", () => {
    expect(domKeyToTerminalData({ key: "k", metaKey: true })).toBeNull();
    expect(domKeyToTerminalData({ key: "Shift", shiftKey: true })).toBeNull();
    expect(domKeyToTerminalData({ key: "F99" })).toBeNull();
  });

  it("frames bracketed paste the way pi-tui's Input/Editor consume it", () => {
    const data = bracketedPaste("hi\nthere");
    expect(data.startsWith("\x1b[200~")).toBe(true);
    expect(data.endsWith("\x1b[201~")).toBe(true);
    expect(data).toContain("hi\nthere");
  });
});

describe("domWheelToTerminalData", () => {
  it("encodes a plain wheel as the SGR sequence a TUI component parses", () => {
    expect(domWheelToTerminalData({ deltaY: -120, col: 0, row: 0 })).toBe("\x1b[<64;1;1M");
    expect(domWheelToTerminalData({ deltaY: 120, col: 9, row: 4 })).toBe("\x1b[<65;10;5M");
  });

  it("ignores horizontal, Ctrl (zoom) and Meta wheels", () => {
    expect(domWheelToTerminalData({ deltaY: 0, deltaX: 40, col: 1, row: 1 })).toBeNull();
    expect(domWheelToTerminalData({ deltaY: 120, ctrlKey: true, col: 1, row: 1 })).toBeNull();
    expect(domWheelToTerminalData({ deltaY: 120, metaKey: true, col: 1, row: 1 })).toBeNull();
  });

  it("clamps negative pointer cells to the first row/column", () => {
    expect(domWheelToTerminalData({ deltaY: 1, col: -5, row: -5 })).toBe("\x1b[<65;1;1M");
  });
});

describe("terminalKeyDecision", () => {
  const win: TerminalKeyContext = {
    platform: "win32",
    hasSelection: false,
    copyOnSelection: false,
  };
  const mac: TerminalKeyContext = { ...win, platform: "darwin" };
  const decision = (input: Parameters<typeof terminalKeyDecision>[0], context = win) =>
    terminalKeyDecision(input, context);

  it("sends the shell's own chords to the pty on Windows/Linux", () => {
    for (const key of ["n", "p", "b", "g", "l", "r", "d", "z", "k", "a", "e"]) {
      expect(decision({ key, ctrlKey: true })).toEqual({ kind: "pty" });
    }
    expect(decision({ key: "Tab" })).toEqual({ kind: "pty" });
    expect(decision({ key: "Escape" })).toEqual({ kind: "pty" });
    expect(decision({ key: "b", altKey: true })).toEqual({ kind: "pty" });
    expect(decision({ key: "[", ctrlKey: true })).toEqual({ kind: "pty" });
  });

  it("claims only the curated Windows/Linux app chords", () => {
    expect(decision({ key: "c", ctrlKey: true, shiftKey: true })).toEqual({
      kind: "app",
      action: "copy",
    });
    expect(decision({ key: "v", ctrlKey: true, shiftKey: true })).toEqual({
      kind: "app",
      action: "paste",
    });
    expect(decision({ key: "v", ctrlKey: true })).toEqual({ kind: "app", action: "paste" });
    expect(decision({ key: "Insert", ctrlKey: true })).toEqual({ kind: "app", action: "copy" });
    expect(decision({ key: "Insert", shiftKey: true })).toEqual({ kind: "app", action: "paste" });
    expect(decision({ key: "f", ctrlKey: true, shiftKey: true })).toEqual({
      kind: "app",
      action: "find",
    });
    expect(decision({ key: "p", ctrlKey: true, shiftKey: true })).toEqual({
      kind: "app",
      action: "command-palette",
    });
    expect(decision({ key: "k", ctrlKey: true, shiftKey: true })).toEqual({
      kind: "app",
      action: "clear",
    });
    expect(decision({ key: "w", ctrlKey: true })).toEqual({
      kind: "app",
      action: "close-terminal",
    });
    expect(decision({ key: "Tab", ctrlKey: true })).toEqual({
      kind: "app",
      action: "next-tab",
    });
    expect(decision({ key: "Tab", ctrlKey: true, shiftKey: true })).toEqual({
      kind: "app",
      action: "previous-tab",
    });
    expect(decision({ key: "`", ctrlKey: true })).toEqual({
      kind: "app",
      action: "toggle-terminal",
    });
    expect(decision({ key: "`", ctrlKey: true, shiftKey: true })).toEqual({
      kind: "app",
      action: "new-terminal",
    });
    expect(decision({ key: "=", ctrlKey: true })).toEqual({ kind: "app", action: "zoom-in" });
    expect(decision({ key: "-", ctrlKey: true })).toEqual({ kind: "app", action: "zoom-out" });
    expect(decision({ key: "0", ctrlKey: true })).toEqual({ kind: "app", action: "zoom-reset" });
  });

  it("copies Ctrl+C only when a selection is there and copyOnSelection is on", () => {
    expect(decision({ key: "c", ctrlKey: true })).toEqual({ kind: "pty" });
    expect(decision({ key: "c", ctrlKey: true }, { ...win, hasSelection: true })).toEqual({
      kind: "pty",
    });
    expect(
      decision({ key: "c", ctrlKey: true }, { ...win, hasSelection: true, copyOnSelection: true }),
    ).toEqual({ kind: "app", action: "copy" });
    expect(
      decision({ key: "c", ctrlKey: true }, { ...win, hasSelection: false, copyOnSelection: true }),
    ).toEqual({ kind: "pty" });
  });

  it("leaves Meta chords to the OS on Windows/Linux", () => {
    expect(decision({ key: "c", metaKey: true })).toEqual({ kind: "ignore" });
    expect(decision({ key: "n", metaKey: true })).toEqual({ kind: "ignore" });
  });

  it("uses Cmd for the app chords on macOS", () => {
    expect(decision({ key: "c", metaKey: true }, mac)).toEqual({ kind: "app", action: "copy" });
    expect(decision({ key: "v", metaKey: true }, mac)).toEqual({ kind: "app", action: "paste" });
    expect(decision({ key: "a", metaKey: true }, mac)).toEqual({
      kind: "app",
      action: "select-all",
    });
    expect(decision({ key: "f", metaKey: true }, mac)).toEqual({ kind: "app", action: "find" });
    expect(decision({ key: "k", metaKey: true }, mac)).toEqual({ kind: "app", action: "clear" });
    expect(decision({ key: "w", metaKey: true }, mac)).toEqual({
      kind: "app",
      action: "close-terminal",
    });
    expect(decision({ key: "`", metaKey: true }, mac)).toEqual({
      kind: "app",
      action: "toggle-terminal",
    });
    expect(decision({ key: "`", metaKey: true, shiftKey: true }, mac)).toEqual({
      kind: "app",
      action: "new-terminal",
    });
    expect(decision({ key: "+", metaKey: true }, mac)).toEqual({
      kind: "app",
      action: "zoom-in",
    });
    expect(decision({ key: "0", metaKey: true }, mac)).toEqual({
      kind: "app",
      action: "zoom-reset",
    });
    expect(decision({ key: "p", metaKey: true, shiftKey: true }, mac)).toEqual({
      kind: "app",
      action: "command-palette",
    });
  });

  it("leaves Cmd+N, Cmd+Q and Cmd+Tab with the menu and the OS", () => {
    expect(decision({ key: "n", metaKey: true }, mac)).toEqual({ kind: "ignore" });
    expect(decision({ key: "q", metaKey: true }, mac)).toEqual({ kind: "ignore" });
    expect(decision({ key: "Tab", metaKey: true }, mac)).toEqual({ kind: "ignore" });
    expect(decision({ key: "p", metaKey: true }, mac)).toEqual({ kind: "ignore" });
  });

  it("sends Ctrl chords to the shell on macOS, including SIGINT", () => {
    expect(decision({ key: "c", ctrlKey: true }, mac)).toEqual({ kind: "pty" });
    expect(decision({ key: "n", ctrlKey: true }, mac)).toEqual({ kind: "pty" });
    expect(decision({ key: "b", ctrlKey: true }, mac)).toEqual({ kind: "pty" });
    expect(decision({ key: "Tab", ctrlKey: true }, mac)).toEqual({
      kind: "app",
      action: "next-tab",
    });
    expect(decision({ key: "c", ctrlKey: true, shiftKey: true }, mac)).toEqual({
      kind: "app",
      action: "copy",
    });
    expect(decision({ key: "b", altKey: true }, mac)).toEqual({ kind: "pty" });
  });
});
