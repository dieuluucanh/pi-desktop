import { describe, expect, it } from "vitest";

import {
  WORKSPACE_PATH_DRAG_MIME,
  WORKSPACE_PATH_DRAG_VERSION,
  insertWorkspaceMention,
  parseWorkspaceDrag,
  serializeWorkspaceDrag,
  workspaceMention,
  type WorkspaceDragPayload,
} from "../../src/shared/workspace-drag";

const payload: WorkspaceDragPayload = {
  version: WORKSPACE_PATH_DRAG_VERSION,
  projectPath: "C:/work/app",
  path: "src/renderer/App.tsx",
  kind: "file",
};

describe("workspace drag payloads", () => {
  it("has a stable custom MIME", () => {
    expect(WORKSPACE_PATH_DRAG_MIME).toBe("application/x-pi-workspace-path");
  });

  it("round-trips a valid payload", () => {
    expect(parseWorkspaceDrag(serializeWorkspaceDrag(payload))).toEqual(payload);
  });

  it("round-trips a directory payload", () => {
    const directory: WorkspaceDragPayload = {
      ...payload,
      path: "src/renderer",
      kind: "directory",
    };
    expect(parseWorkspaceDrag(serializeWorkspaceDrag(directory))).toEqual(directory);
  });

  it("rejects malformed or unsafe payloads", () => {
    expect(parseWorkspaceDrag(null)).toBeNull();
    expect(parseWorkspaceDrag(undefined)).toBeNull();
    expect(parseWorkspaceDrag("")).toBeNull();
    expect(parseWorkspaceDrag("not json")).toBeNull();
    expect(parseWorkspaceDrag("[]")).toBeNull();
    expect(parseWorkspaceDrag("null")).toBeNull();
    expect(parseWorkspaceDrag(JSON.stringify({ ...payload, path: "/etc/passwd" }))).toBeNull();
    expect(parseWorkspaceDrag(JSON.stringify({ ...payload, path: "../outside.ts" }))).toBeNull();
    expect(parseWorkspaceDrag(JSON.stringify({ ...payload, path: "src\\App.tsx" }))).toBeNull();
    expect(parseWorkspaceDrag(JSON.stringify({ ...payload, path: ".git/config" }))).toBeNull();
    expect(parseWorkspaceDrag(JSON.stringify({ ...payload, kind: "symlink" }))).toBeNull();
    expect(parseWorkspaceDrag(JSON.stringify({ ...payload, version: 2 }))).toBeNull();
    expect(parseWorkspaceDrag(JSON.stringify({ ...payload, projectPath: "  " }))).toBeNull();
    expect(
      parseWorkspaceDrag(JSON.stringify({ ...payload, projectPath: "C:/x", path: 42 })),
    ).toBeNull();
  });
});

describe("workspaceMention", () => {
  it("uses the Pi @ convention for files and folders", () => {
    expect(workspaceMention("src/App.tsx", "file")).toBe("@src/App.tsx");
    expect(workspaceMention("src/renderer", "directory")).toBe("@src/renderer/");
    expect(workspaceMention("src/renderer/", "directory")).toBe("@src/renderer/");
  });

  it("quotes paths containing whitespace", () => {
    expect(workspaceMention("docs/product notes.md", "file")).toBe('@"docs/product notes.md"');
    expect(workspaceMention("my folder", "directory")).toBe('@"my folder/"');
  });

  it("does not try to escape a literal quote in a name", () => {
    expect(workspaceMention('a"b c.ts', "file")).toBe('@a"b c.ts');
  });
});

describe("insertWorkspaceMention", () => {
  it("inserts at an empty buffer with a trailing space", () => {
    expect(insertWorkspaceMention("", 0, 0, "@src/App.tsx")).toEqual({
      text: "@src/App.tsx ",
      caret: 13,
    });
  });

  it("inserts in the middle of a word with both separators", () => {
    expect(insertWorkspaceMention("look at here now", 8, 8, "@src/App.tsx")).toEqual({
      text: "look at @src/App.tsx here now",
      caret: 21,
    });
  });

  it("inserts at the start without a leading space", () => {
    expect(insertWorkspaceMention("please review", 0, 0, "@src/App.tsx")).toEqual({
      text: "@src/App.tsx please review",
      caret: 13,
    });
  });

  it("keeps existing spaces before the insertion", () => {
    expect(insertWorkspaceMention("look at  here", 8, 8, "@src/App.tsx")).toEqual({
      text: "look at @src/App.tsx here",
      caret: 20,
    });
  });

  it("adds a leading space before a newline boundary", () => {
    expect(insertWorkspaceMention("look at\nnext", 7, 7, "@src/App.tsx")).toEqual({
      text: "look at @src/App.tsx\nnext",
      caret: 20,
    });
  });

  it("replaces the selected range", () => {
    expect(insertWorkspaceMention("look at OLD now", 8, 11, "@src/App.tsx")).toEqual({
      text: "look at @src/App.tsx now",
      caret: 20,
    });
  });

  it("clamps a malformed range", () => {
    expect(insertWorkspaceMention("abc", 99, -1, "@x")).toEqual({
      text: "abc @x ",
      caret: 7,
    });
  });
});
