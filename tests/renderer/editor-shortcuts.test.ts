import { describe, expect, it } from "vitest";

import { editorShortcut, type EditorKeyEvent } from "../../src/renderer/src/editor/shortcuts";

function key(overrides: Partial<EditorKeyEvent> = {}): EditorKeyEvent {
  return {
    key: "s",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("editorShortcut", () => {
  it("maps Mod-s to save on Windows/Linux and macOS", () => {
    expect(editorShortcut(key({ ctrlKey: true }))).toBe("save");
    expect(editorShortcut(key({ metaKey: true }))).toBe("save");
    expect(editorShortcut(key({ key: "S", ctrlKey: true }))).toBe("save");
  });

  it("does not claim Save As or extra-modifier variants", () => {
    expect(editorShortcut(key({ ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(editorShortcut(key({ ctrlKey: true, altKey: true }))).toBeNull();
    expect(editorShortcut(key({ metaKey: true, shiftKey: true }))).toBeNull();
    expect(editorShortcut(key({ altKey: true }))).toBeNull();
  });

  it("maps Shift+Alt+F to format", () => {
    expect(editorShortcut(key({ key: "f", shiftKey: true, altKey: true }))).toBe("format");
    expect(editorShortcut(key({ key: "F", shiftKey: true, altKey: true }))).toBe("format");
  });

  it("does not claim format with Ctrl or Cmd held", () => {
    expect(
      editorShortcut(key({ key: "f", ctrlKey: true, shiftKey: true, altKey: true })),
    ).toBeNull();
    expect(
      editorShortcut(key({ key: "f", metaKey: true, shiftKey: true, altKey: true })),
    ).toBeNull();
  });

  it("ignores unrelated keys and events CodeMirror already handled", () => {
    expect(editorShortcut(key({ key: "o", ctrlKey: true }))).toBeNull();
    expect(editorShortcut(key({ ctrlKey: true, defaultPrevented: true }))).toBeNull();
  });
});
