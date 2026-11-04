import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { contextMenuTemplate, type ContextMenuState } from "../../src/main/context-menu";

/**
 * The right-click menu template (2026-10-30 copy plan). Electron has no default
 * context menu; this pure template decides the labels, order and enabled flags,
 * while `index.ts` supplies the `webContents` edit actions.
 */

function state(overrides: Partial<ContextMenuState> = {}): ContextMenuState {
  return {
    selectionText: "",
    isEditable: false,
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: false,
    canSelectAll: false,
    ...overrides,
  };
}

function actions() {
  return {
    undo: vi.fn(),
    redo: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
  };
}

const labels = (template: MenuItemConstructorOptions[]): string[] =>
  template.map((item) => (item.type === "separator" ? "—" : (item.label ?? "")));

describe("contextMenuTemplate", () => {
  it("offers Copy for a non-editable selection", () => {
    const template = contextMenuTemplate(state({ selectionText: "picked" }), actions());

    expect(labels(template)).toEqual(["Copy"]);
    expect(template[0]?.enabled).toBe(true);
  });

  it("returns nothing for a non-editable target with no selection", () => {
    expect(contextMenuTemplate(state(), actions())).toEqual([]);
  });

  it("offers the full editing menu for an editable field", () => {
    const template = contextMenuTemplate(
      state({
        isEditable: true,
        canUndo: true,
        canRedo: false,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
      }),
      actions(),
    );

    expect(labels(template)).toEqual([
      "Undo",
      "Redo",
      "—",
      "Cut",
      "Copy",
      "Paste",
      "—",
      "Select All",
    ]);
    expect(template.find((item) => item.id === "undo")?.enabled).toBe(true);
    expect(template.find((item) => item.id === "redo")?.enabled).toBe(false);
    expect(template.find((item) => item.id === "paste")?.enabled).toBe(true);
  });

  it("wires every item to the supplied action", () => {
    const handlers = actions();
    const template = contextMenuTemplate(state({ isEditable: true, canCopy: true }), handlers);

    for (const item of template) {
      if (item.type === "separator" || !item.click) continue;
      (item.click as unknown as () => void)();
    }

    expect(handlers.undo).toHaveBeenCalledTimes(1);
    expect(handlers.redo).toHaveBeenCalledTimes(1);
    expect(handlers.cut).toHaveBeenCalledTimes(1);
    expect(handlers.copy).toHaveBeenCalledTimes(1);
    expect(handlers.paste).toHaveBeenCalledTimes(1);
    expect(handlers.selectAll).toHaveBeenCalledTimes(1);
  });
});
