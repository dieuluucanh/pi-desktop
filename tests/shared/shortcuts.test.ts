import { describe, expect, it } from "vitest";

import {
  EMPTY_SHORTCUTS,
  sanitizeShortcutsSnapshot,
  sortShortcuts,
} from "../../src/shared/shortcuts";

describe("sanitizeShortcutsSnapshot", () => {
  it("keeps valid rows and drops hostile ones", () => {
    const snapshot = sanitizeShortcutsSnapshot({
      shortcuts: [
        { key: "ctrl+g", description: "open", extensionPath: "C:\\x\\ext", source: "ext" },
        { key: "ctrl+h", extensionPath: "C:\\y\\other" },
        { key: 42, extensionPath: "C:\\z" },
        { extensionPath: "C:\\z" },
      ],
      diagnostics: [{ type: "collision", message: "clash", path: "C:\\x" }, { nope: true }],
      loadedAt: 12,
    });
    expect(snapshot.shortcuts).toHaveLength(2);
    expect(snapshot.shortcuts[1]?.source).toBe("other");
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.loadedAt).toBe(12);
  });

  it("defaults an empty payload", () => {
    expect(sanitizeShortcutsSnapshot(null)).toEqual(EMPTY_SHORTCUTS);
  });
});

describe("sortShortcuts", () => {
  it("orders by key then owner", () => {
    const sorted = sortShortcuts([
      { key: "ctrl+g", extensionPath: "b", source: "b" },
      { key: "ctrl+a", extensionPath: "a", source: "a" },
      { key: "ctrl+g", extensionPath: "a", source: "a" },
    ]);
    expect(sorted.map((entry) => `${entry.key}:${entry.extensionPath}`)).toEqual([
      "ctrl+a:a",
      "ctrl+g:a",
      "ctrl+g:b",
    ]);
  });
});
