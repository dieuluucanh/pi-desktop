import { describe, expect, it } from "vitest";
import {
  collapseDuplicateSessionTabs,
  findTabBySessionFile,
  normalizeSessionFile,
  sameSessionFile,
} from "../../src/shared/session-file";
import type { TabRecord } from "../../src/shared/session-ipc";

/**
 * Session-file identity (2026-11-06 current-session plan). One JSONL is one
 * conversation and may have one live manager, so every comparison of a row, a
 * tab or a resume request goes through these rules instead of `===`.
 */

const SESSION = "C:\\Users\\Lenovo\\.pi\\agent\\sessions\\proj\\s1.jsonl";

function tab(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: "C:\\work\\app",
    title: "app",
    sessionFile: null,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
    ...overrides,
  };
}

describe("normalizeSessionFile", () => {
  it("unifies separators and folds Windows drive case", () => {
    expect(normalizeSessionFile("C:\\Users\\Lenovo\\s1.jsonl")).toBe("c:/users/lenovo/s1.jsonl");
    expect(normalizeSessionFile("c:/Users/Lenovo/s1.jsonl")).toBe("c:/users/lenovo/s1.jsonl");
  });

  it("drops trailing separators, like the project rule", () => {
    expect(normalizeSessionFile("C:\\Users\\Lenovo\\sessions\\")).toBe("c:/users/lenovo/sessions");
  });

  it("folds case for UNC paths", () => {
    expect(normalizeSessionFile("\\\\Server\\Share\\S1.jsonl")).toBe("//server/share/s1.jsonl");
  });

  it("keeps POSIX paths case-sensitive", () => {
    expect(normalizeSessionFile("/home/me/S1.jsonl")).toBe("/home/me/S1.jsonl");
  });

  it("returns an empty string for an empty path", () => {
    expect(normalizeSessionFile("")).toBe("");
    expect(normalizeSessionFile("   ")).toBe("");
  });
});

describe("sameSessionFile", () => {
  it("matches a path written with the other separator or drive case", () => {
    expect(sameSessionFile(SESSION, "c:/users/lenovo/.pi/agent/sessions/proj/s1.jsonl")).toBe(true);
  });

  it("does not fold case on POSIX", () => {
    expect(sameSessionFile("/home/me/S1.jsonl", "/home/me/s1.jsonl")).toBe(false);
  });

  it("never matches a missing or empty path", () => {
    expect(sameSessionFile(null, SESSION)).toBe(false);
    expect(sameSessionFile(SESSION, undefined)).toBe(false);
    expect(sameSessionFile("", "")).toBe(false);
  });
});

describe("findTabBySessionFile", () => {
  it("finds a session tab through a separator/case variant", () => {
    const found = findTabBySessionFile(
      [tab({ id: "tab-1", sessionFile: SESSION })],
      "c:/users/lenovo/.pi/agent/sessions/proj/s1.jsonl",
    );
    expect(found?.id).toBe("tab-1");
  });

  it("finds an Office tab (both kinds are host-backed)", () => {
    const found = findTabBySessionFile(
      [tab({ id: "office-1", kind: "office", sessionFile: SESSION })],
      SESSION,
    );
    expect(found?.id).toBe("office-1");
  });

  it("ignores editor and web tabs even when they carry the path", () => {
    const tabs = [
      tab({ id: "editor-1", kind: "editor", sessionFile: SESSION, filePath: "a.ts" }),
      tab({ id: "web-1", kind: "web", sessionFile: SESSION, url: "http://127.0.0.1:1/x" }),
    ];
    expect(findTabBySessionFile(tabs, SESSION)).toBeNull();
  });

  it("returns the first match in table order", () => {
    const tabs = [
      tab({ id: "tab-b", sessionFile: SESSION, lastActiveAt: 1 }),
      tab({ id: "tab-a", sessionFile: SESSION, lastActiveAt: 9 }),
    ];
    expect(findTabBySessionFile(tabs, SESSION)?.id).toBe("tab-b");
  });

  it("never matches an empty session file or a tab without a manager", () => {
    expect(findTabBySessionFile([tab({ id: "tab-1", sessionFile: SESSION })], "")).toBeNull();
    expect(findTabBySessionFile([tab({ id: "tab-1", sessionFile: null })], SESSION)).toBeNull();
  });
});

describe("collapseDuplicateSessionTabs", () => {
  it("leaves a unique table untouched", () => {
    const tabs = [
      tab({ id: "tab-1", sessionFile: SESSION }),
      tab({ id: "tab-2", sessionFile: "C:\\sessions\\s2.jsonl" }),
      tab({ id: "editor-1", kind: "editor", filePath: "a.ts" }),
    ];

    const collapsed = collapseDuplicateSessionTabs(tabs);

    expect(collapsed.tabs).toEqual(tabs);
    expect(collapsed.replacedTabIds.size).toBe(0);
  });

  it("keeps the most recently active tab and reports the dropped id", () => {
    const tabs = [
      tab({ id: "old", sessionFile: SESSION, lastActiveAt: 1 }),
      tab({ id: "new", sessionFile: SESSION, lastActiveAt: 9 }),
    ];

    const collapsed = collapseDuplicateSessionTabs(tabs);

    expect(collapsed.tabs.map((entry) => entry.id)).toEqual(["new"]);
    // The kept record takes the first duplicate's position.
    expect(collapsed.tabs[0]?.lastActiveAt).toBe(9);
    expect(collapsed.replacedTabIds.get("old")).toBe("new");
  });

  it("keeps the first on a tie", () => {
    const tabs = [
      tab({ id: "first", sessionFile: SESSION, lastActiveAt: 5 }),
      tab({ id: "second", sessionFile: SESSION, lastActiveAt: 5 }),
    ];

    const collapsed = collapseDuplicateSessionTabs(tabs);

    expect(collapsed.tabs.map((entry) => entry.id)).toEqual(["first"]);
    expect(collapsed.replacedTabIds.get("second")).toBe("first");
  });

  it("keeps a pin carried by a dropped duplicate", () => {
    const tabs = [
      tab({ id: "old", sessionFile: SESSION, lastActiveAt: 1, pinned: true }),
      tab({ id: "new", sessionFile: SESSION, lastActiveAt: 9 }),
    ];

    const collapsed = collapseDuplicateSessionTabs(tabs);

    expect(collapsed.tabs).toHaveLength(1);
    expect(collapsed.tabs[0]).toMatchObject({ id: "new", pinned: true });
  });

  it("preserves the position of the first duplicate among other tabs", () => {
    const tabs = [
      tab({ id: "before", sessionFile: "C:\\sessions\\s0.jsonl" }),
      tab({ id: "old", sessionFile: SESSION, lastActiveAt: 1 }),
      tab({ id: "after", sessionFile: "C:\\sessions\\s9.jsonl" }),
      tab({ id: "new", sessionFile: SESSION, lastActiveAt: 9 }),
    ];

    const collapsed = collapseDuplicateSessionTabs(tabs);

    expect(collapsed.tabs.map((entry) => entry.id)).toEqual(["before", "new", "after"]);
  });

  it("resolves a chain of duplicates to the final tab", () => {
    const tabs = [
      tab({ id: "a", sessionFile: SESSION, lastActiveAt: 1 }),
      tab({ id: "b", sessionFile: SESSION, lastActiveAt: 2 }),
      tab({ id: "c", sessionFile: SESSION, lastActiveAt: 3 }),
    ];

    const collapsed = collapseDuplicateSessionTabs(tabs);

    expect(collapsed.tabs.map((entry) => entry.id)).toEqual(["c"]);
    expect(collapsed.replacedTabIds.get("a")).toBe("c");
    expect(collapsed.replacedTabIds.get("b")).toBe("c");
  });

  it("does not merge tabs that have no session file", () => {
    const tabs = [
      tab({ id: "new-a", sessionFile: null }),
      tab({ id: "new-b", sessionFile: null }),
      tab({ id: "editor-1", kind: "editor", filePath: "a.ts" }),
    ];

    const collapsed = collapseDuplicateSessionTabs(tabs);

    expect(collapsed.tabs.map((entry) => entry.id)).toEqual(["new-a", "new-b", "editor-1"]);
    expect(collapsed.replacedTabIds.size).toBe(0);
  });
});
