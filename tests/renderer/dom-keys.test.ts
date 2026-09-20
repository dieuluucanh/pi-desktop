import { describe, expect, it } from "vitest";

import {
  domKeyId,
  isEditableTarget,
  matchShortcut,
  matchesBinding,
} from "../../src/renderer/src/shortcuts/dom-keys";

function key(overrides: Partial<Parameters<typeof domKeyId>[0]> = {}) {
  return {
    key: "g",
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...overrides,
  };
}

describe("domKeyId", () => {
  it("normalizes printable keys and modifiers into Pi chords", () => {
    expect(domKeyId(key({ key: "g", ctrlKey: true }))).toBe("ctrl+g");
    expect(domKeyId(key({ key: "G", shiftKey: true }))).toBe("shift+g");
    expect(domKeyId(key({ key: "Enter" }))).toBe("enter");
    expect(domKeyId(key({ key: " ", ctrlKey: true }))).toBe("ctrl+space");
    expect(domKeyId(key({ key: "ArrowLeft", altKey: true }))).toBe("alt+left");
    expect(domKeyId(key({ key: "PageUp" }))).toBe("pageUp");
  });

  it("never claims menu or modifier-only events", () => {
    expect(domKeyId(key({ key: "g", metaKey: true, ctrlKey: true }))).toBeNull();
    expect(domKeyId(key({ key: "Shift", shiftKey: true }))).toBeNull();
    expect(domKeyId(key({ key: "F5" }))).toBeNull();
  });
});

describe("matchShortcut", () => {
  const shortcuts = [{ key: "ctrl+g" }, { key: "shift+ctrl+o" }];

  it("matches canonically across modifier order", () => {
    expect(matchShortcut(key({ key: "g", ctrlKey: true }), shortcuts)).toBe("ctrl+g");
    expect(matchShortcut(key({ key: "O", ctrlKey: true, shiftKey: true }), shortcuts)).toBe(
      "shift+ctrl+o",
    );
    expect(matchShortcut(key({ key: "z", ctrlKey: true }), shortcuts)).toBeNull();
  });
});

describe("matchesBinding (plan step 18)", () => {
  it("matches an app binding canonically", () => {
    expect(matchesBinding(key({ key: "o", ctrlKey: true }), ["ctrl+o"])).toBe(true);
    expect(matchesBinding(key({ key: "O", ctrlKey: true, shiftKey: true }), ["shift+ctrl+o"])).toBe(
      true,
    );
    expect(matchesBinding(key({ key: "o", ctrlKey: true }), ["ctrl+shift+o"])).toBe(false);
    expect(matchesBinding(key({ key: "o", ctrlKey: true }), [])).toBe(false);
    // Meta chords belong to the OS and are never claimed.
    expect(matchesBinding(key({ key: "o", metaKey: true }), ["ctrl+o"])).toBe(false);
  });
});

describe("isEditableTarget", () => {
  it("detects text fields and leaves the rest alone", () => {
    const input = document.createElement("input");
    const div = document.createElement("div");
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(div)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
