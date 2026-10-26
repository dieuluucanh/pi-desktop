import { describe, expect, it } from "vitest";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  bracketedPaste,
  domKeyToTerminalData,
  domWheelToTerminalData,
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
