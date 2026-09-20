import { describe, expect, it } from "vitest";
import {
  isTabKind,
  sanitizeTabRecord,
  sanitizeTabs,
  sessionTitle,
  TAB_KINDS,
} from "../../src/shared/session-ipc";

/**
 * Tab records travel through app state (plan step 21), so the sanitizers are
 * what stop a hand-edited `app-state.json` from producing an unusable tab — a
 * web tab with no permitted URL, or a host-backed tab with no folder.
 */

describe("tab kinds", () => {
  it("knows session, office and web", () => {
    expect(TAB_KINDS).toEqual(["session", "office", "web"]);
    expect(isTabKind("web")).toBe(true);
    expect(isTabKind("popup")).toBe(false);
  });
});

describe("sanitizeTabRecord", () => {
  it("keeps a well-formed session tab", () => {
    const tab = sanitizeTabRecord({
      id: "tab-1",
      kind: "session",
      cwd: "C:\\work\\app",
      status: "running",
      model: "anthropic/x",
    });
    expect(tab).toMatchObject({
      id: "tab-1",
      kind: "session",
      cwd: "C:\\work\\app",
      title: "app",
      status: "running",
      model: "anthropic/x",
    });
    expect(tab?.url).toBeUndefined();
  });

  it("keeps a web tab's URL and originating session", () => {
    const tab = sanitizeTabRecord({
      id: "tab-2",
      kind: "web",
      cwd: "",
      url: "http://127.0.0.1:19432/review/abc",
      sessionTabId: "tab-1",
      title: "Review",
    });
    expect(tab).toEqual({
      id: "tab-2",
      kind: "web",
      cwd: "",
      title: "Review",
      sessionFile: null,
      status: "idle",
      createdAt: 0,
      lastActiveAt: 0,
      model: null,
      url: "http://127.0.0.1:19432/review/abc",
      sessionTabId: "tab-1",
    });
  });

  it("defaults a web tab's title to its host", () => {
    const tab = sanitizeTabRecord({ id: "t", kind: "web", url: "http://localhost:5173/app" });
    expect(tab?.title).toBe("localhost:5173");
    expect(tab?.sessionTabId).toBeNull();
  });

  it("drops a web tab without a permitted URL, and a session tab without a folder", () => {
    expect(sanitizeTabRecord({ id: "t", kind: "web" })).toBeNull();
    expect(sanitizeTabRecord({ id: "t", kind: "web", url: "file:///etc/passwd" })).toBeNull();
    expect(sanitizeTabRecord({ id: "t", kind: "session", cwd: "" })).toBeNull();
    expect(sanitizeTabRecord({ kind: "session", cwd: "C:\\x" })).toBeNull();
    expect(sanitizeTabRecord(null)).toBeNull();
  });
});

describe("sanitizeTabs", () => {
  it("keeps usable entries and drops the rest in order", () => {
    const tabs = sanitizeTabs([
      { id: "a", cwd: "C:\\one" },
      { id: "bad", kind: "web" },
      { id: "b", kind: "web", url: "http://localhost:1/x", sessionTabId: "a" },
      "nonsense",
    ]);
    expect(tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
    expect(sanitizeTabs("nope")).toEqual([]);
  });
});

describe("sessionTitle", () => {
  it("uses the last path segment", () => {
    expect(sessionTitle("C:\\work\\pi-desktop")).toBe("pi-desktop");
    expect(sessionTitle("/home/me/project/")).toBe("project");
  });
});
