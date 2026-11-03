import { describe, expect, it } from "vitest";

import {
  explorerMenuItems,
  type ExplorerMenuState,
  type ExplorerMenuTarget,
} from "../../src/renderer/src/rail/explorer-menu";

const FILE: ExplorerMenuTarget = {
  kind: "file",
  path: "src/app.ts",
  name: "app.ts",
  outside: false,
};

const FOLDER: ExplorerMenuTarget = {
  kind: "directory",
  path: "src",
  name: "src",
  outside: false,
};

const EMPTY: ExplorerMenuState = { clipboard: null };
const COPYING: ExplorerMenuState = { clipboard: { mode: "copy" } };

function ids(target: ExplorerMenuTarget | null, state = EMPTY) {
  return explorerMenuItems(target, state).map((item) => item.id);
}

describe("explorerMenuItems", () => {
  it("lists file actions in VS Code order", () => {
    expect(ids(FILE)).toEqual([
      "open",
      "add-to-chat",
      "copy",
      "cut",
      "paste",
      "rename",
      "delete",
      "reveal",
      "copy-path",
      "copy-relative-path",
    ]);
    expect(ids(FILE, COPYING).includes("paste")).toBe(true);
    expect(explorerMenuItems(FILE, COPYING).find((item) => item.id === "paste")?.disabled).toBe(
      undefined,
    );
    expect(explorerMenuItems(FILE, EMPTY).find((item) => item.id === "paste")?.disabled).toBe(true);
  });

  it("lists folder creation and folder-chat actions", () => {
    expect(ids(FOLDER)).toEqual([
      "new-file",
      "new-folder",
      "add-to-chat",
      "copy",
      "cut",
      "paste",
      "rename",
      "delete",
      "reveal",
      "copy-path",
      "copy-relative-path",
    ]);
    expect(explorerMenuItems(FOLDER, EMPTY).find((item) => item.id === "add-to-chat")?.label).toBe(
      "Add Folder to Chat",
    );
  });

  it("lists root actions when there is no target", () => {
    expect(ids(null)).toEqual(["new-file", "new-folder", "paste", "refresh"]);
    expect(explorerMenuItems(null, COPYING).find((item) => item.id === "paste")?.disabled).toBe(
      undefined,
    );
  });

  it("disables actions that would follow an outside link", () => {
    const outside = { ...FILE, outside: true };
    const items = explorerMenuItems(outside, COPYING);
    expect(items.find((item) => item.id === "open")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "add-to-chat")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "copy")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "cut")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "delete")?.disabled).toBeUndefined();
    expect(items.find((item) => item.id === "rename")?.disabled).toBeUndefined();
  });

  it("marks destructive and separated items", () => {
    const items = explorerMenuItems(FILE, COPYING);
    expect(items.find((item) => item.id === "delete")?.destructive).toBe(true);
    expect(items.find((item) => item.id === "rename")?.separated).toBe(true);
    expect(items.find((item) => item.id === "copy-path")?.separated).toBe(true);
  });
});
