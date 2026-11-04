import { describe, expect, it } from "vitest";

import {
  documentScopeNote,
  mostRecentSessionTabForFolder,
  railScopeFolder,
  sameFolder,
} from "../../src/shared/rail-scope";
import type { TabKind } from "../../src/shared/session-ipc";

/**
 * The rail's scope model.
 *
 * These are the rules the panel's folder and the Documents note are built from,
 * so they are asserted on their own rather than through a render: a mistake here
 * would show up as the wrong project's changes in the rail.
 */

const tab = (id: string, cwd: string, lastActiveAt: number, kind: TabKind = "session") => ({
  id,
  kind,
  cwd,
  lastActiveAt,
});

describe("raulScopeFolder", () => {
  it("prefers the selected project over the active session's folder", () => {
    expect(
      railScopeFolder({
        projectPath: "C:/work/app",
        activeTab: { kind: "session", cwd: "C:/work/other" },
      }),
    ).toBe("C:/work/app");
  });

  it("falls back to the active session's folder when no project is selected", () => {
    expect(
      railScopeFolder({ projectPath: null, activeTab: { kind: "session", cwd: "C:/work/app" } }),
    ).toBe("C:/work/app");
  });

  it("never takes a folder from a web tab", () => {
    expect(
      railScopeFolder({ projectPath: null, activeTab: { kind: "web", cwd: "C:/work/app" } }),
    ).toBeNull();
  });

  it("ignores empty and whitespace-only folders", () => {
    expect(railScopeFolder({ projectPath: "   " })).toBeNull();
    expect(
      railScopeFolder({ projectPath: null, activeTab: { kind: "session", cwd: "  " } }),
    ).toBeNull();
    expect(railScopeFolder({ projectPath: null })).toBeNull();
  });
});

describe("sameFolder", () => {
  it("ignores separator direction, trailing separators and case", () => {
    expect(sameFolder("C:\\work\\app", "c:/work/app/")).toBe(true);
    expect(sameFolder("/work/app", "/work/app/")).toBe(true);
  });

  it("keeps a filesystem root distinct from a drive-relative path", () => {
    expect(sameFolder("C:\\", "C:")).toBe(false);
    expect(sameFolder("D:/", "D:\\")).toBe(true);
  });

  it("never matches an empty side", () => {
    expect(sameFolder(null, "/work/app")).toBe(false);
    expect(sameFolder("/work/app", undefined)).toBe(false);
    expect(sameFolder("", "")).toBe(false);
  });
});

describe("mostRecentSessionTabForFolder", () => {
  const tabs = [
    tab("a1", "C:/work/a", 10),
    tab("a2", "C:/work/a/", 40),
    tab("b1", "C:/work/b", 99),
    tab("w1", "C:/work/a", 500, "web"),
  ];

  it("returns the most recently active session tab in the folder", () => {
    expect(mostRecentSessionTabForFolder(tabs, "C:/work/a")?.id).toBe("a2");
  });

  it("never selects a web tab, even when it is the most recent", () => {
    const found = mostRecentSessionTabForFolder(tabs, "C:/work/a");
    expect(found?.kind).not.toBe("web");
  });

  it("never selects an editor tab, even when it is the most recent", () => {
    const withEditor = [...tabs, tab("e1", "C:/work/a", 900, "editor")];
    expect(mostRecentSessionTabForFolder(withEditor, "C:/work/a")?.id).toBe("a2");
  });

  it("returns null for a folder with no open tab", () => {
    expect(mostRecentSessionTabForFolder(tabs, "C:/work/c")).toBeNull();
    expect(mostRecentSessionTabForFolder(tabs, null)).toBeNull();
    expect(mostRecentSessionTabForFolder(tabs, "")).toBeNull();
  });

  it("compares folders tolerantly, so a differently-spelled path still matches", () => {
    expect(mostRecentSessionTabForFolder(tabs, "c:\\work\\A\\")?.id).toBe("a2");
  });

  it("keeps the first tab when activity timestamps tie", () => {
    const tied = [tab("first", "C:/work/a", 5), tab("second", "C:/work/a", 5)];
    expect(mostRecentSessionTabForFolder(tied, "C:/work/a")?.id).toBe("first");
  });
});

describe("documentScopeNote", () => {
  const host = { title: "Office session", projectPath: "C:/work/office" };

  it("says so plainly when this session is the host", () => {
    expect(documentScopeNote({ host, isHost: true, railFolder: "C:/work/office" })).toEqual({
      tone: "host",
      text: "This session is the Office host.",
    });
  });

  it("names the host's folder when it is a different project", () => {
    expect(documentScopeNote({ host, isHost: false, railFolder: "C:/work/app" })).toEqual({
      tone: "other",
      text: "Office host: Office session · C:/work/office",
    });
  });

  it("omits the folder when the host is in the rail's own folder", () => {
    expect(documentScopeNote({ host, isHost: false, railFolder: "C:/work/office/" })).toEqual({
      tone: "other",
      text: "Office host: Office session",
    });
  });

  it("says nothing when no session holds the bridge", () => {
    expect(documentScopeNote({ host: null, isHost: false, railFolder: "C:/work/app" })).toBeNull();
  });

  it("names the host even when the rail has no folder to compare", () => {
    expect(documentScopeNote({ host, isHost: false, railFolder: null })).toEqual({
      tone: "other",
      text: "Office host: Office session · C:/work/office",
    });
  });
});
