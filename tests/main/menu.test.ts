import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { MENU_COMMANDS, type MenuCommand } from "../../src/shared/ipc";
import { menuTemplate } from "../../src/main/menu";

/**
 * The menu is the app's command surface and the only owner of the global
 * accelerators, so its ids must stay in lockstep with `MENU_COMMANDS` — a new
 * command without a menu entry (or a dropped entry) fails here.
 */

function collectIds(items: readonly MenuItemConstructorOptions[], into: string[] = []): string[] {
  for (const item of items) {
    if (typeof item.id === "string") into.push(item.id);
    if (Array.isArray(item.submenu)) collectIds(item.submenu, into);
  }
  return into;
}

function allItems(
  items: readonly MenuItemConstructorOptions[],
  into: MenuItemConstructorOptions[] = [],
): MenuItemConstructorOptions[] {
  for (const item of items) {
    into.push(item);
    if (Array.isArray(item.submenu)) allItems(item.submenu, into);
  }
  return into;
}

function build(isMac = false): {
  template: MenuItemConstructorOptions[];
  onCommand: ReturnType<typeof vi.fn>;
  onOpenExternal: ReturnType<typeof vi.fn>;
} {
  const onCommand = vi.fn();
  const onOpenExternal = vi.fn();
  const template = menuTemplate({
    appName: "Pi Desktop",
    isMac,
    onCommand,
    onOpenExternal,
  });
  return { template, onCommand, onOpenExternal };
}

describe("menuTemplate", () => {
  it("exposes every MenuCommand exactly once", () => {
    const { template } = build();
    const ids = collectIds(template);
    for (const command of MENU_COMMANDS) {
      expect(ids.filter((id) => id === command).length, `menu id ${command}`).toBe(1);
    }
    expect(ids.length).toBe(MENU_COMMANDS.length);
  });

  it("puts New Session in File with the Ctrl+N accelerator", () => {
    const { template } = build();
    const file = template.find((item) => item.label === "File");
    const newSession = (file?.submenu as MenuItemConstructorOptions[]).find(
      (item) => item.id === "new-session",
    );
    expect(newSession?.label).toBe("New Session");
    expect(newSession?.accelerator).toBe("CmdOrCtrl+N");
  });

  it("leaves Ctrl+O to the app's tool-expand binding (plan step 18)", () => {
    const { template } = build();
    const accelerators = allItems(template)
      .map((item) => item.accelerator)
      .filter((value): value is string => typeof value === "string");
    // A menu accelerator is consumed before the renderer sees the keydown, so a
    // `Ctrl+O` menu item would silently shadow `app.tools.expand`.
    expect(accelerators).not.toContain("CmdOrCtrl+O");
  });

  it("binds app zoom to Ctrl+= / Ctrl+- / Ctrl+0, not Electron's roles", () => {
    const { template } = build();
    const items = allItems(template);
    const zoom = items
      .filter((item) => item.id?.startsWith("zoom-"))
      .map((item) => [item.id, item.accelerator]);

    expect(zoom).toEqual([
      ["zoom-in", "CmdOrCtrl+="],
      ["zoom-out", "CmdOrCtrl+-"],
      ["zoom-reset", "CmdOrCtrl+0"],
    ]);
    // The role binds `Plus` (Ctrl+Shift+=) on Windows/Linux, which is the bug
    // this menu path replaces (electron#40674).
    expect(items.some((item) => item.role === "zoomIn")).toBe(false);
    expect(items.some((item) => item.role === "zoomOut")).toBe(false);
    expect(items.some((item) => item.role === "resetZoom")).toBe(false);
  });

  it("keeps Pi for Office out of the primary menus", () => {
    const { template } = build();
    const fileIds = collectIds(
      (template.find((item) => item.label === "File")?.submenu as MenuItemConstructorOptions[]) ??
        [],
    );
    expect(fileIds).not.toContain("view-office");
    const integrations = template.find((item) => item.label === "Integrations");
    expect(collectIds((integrations?.submenu as MenuItemConstructorOptions[]) ?? [])).toEqual([
      "view-office",
    ]);
  });

  it("forwards clicks as MenuCommands", () => {
    const { template, onCommand } = build();
    const item = allItems(template).find((entry) => entry.id === "command-palette");
    (item?.click as unknown as () => void)?.();
    expect(onCommand).toHaveBeenCalledWith("command-palette" satisfies MenuCommand);
  });

  it("opens the Pi documentation externally from Help", () => {
    const { template, onOpenExternal } = build();
    const help = template.find((item) => item.label === "Help");
    const docs = (help?.submenu as MenuItemConstructorOptions[]).find(
      (item) => item.label === "Pi Documentation",
    );
    (docs?.click as unknown as () => void)?.();
    expect(onOpenExternal).toHaveBeenCalledTimes(1);
  });

  it("routes About to the in-app card on Windows/Linux and keeps the native panel on macOS", () => {
    const winHelp = build(false).template.find((item) => item.label === "Help");
    const winItems = (winHelp?.submenu as MenuItemConstructorOptions[]) ?? [];
    expect(winItems.some((item) => item.id === "view-about")).toBe(true);
    expect(winItems.some((item) => item.role === "about")).toBe(false);

    const mac = build(true).template;
    const macHelp = mac.find((item) => item.label === "Help");
    const macItems = (macHelp?.submenu as MenuItemConstructorOptions[]) ?? [];
    expect(macItems.some((item) => item.id === "view-about")).toBe(false);
    const macAppItems = (mac[0]?.submenu as MenuItemConstructorOptions[]) ?? [];
    expect(macAppItems.some((item) => item.role === "about")).toBe(true);
  });

  it("adds the macOS application menu only on darwin", () => {
    const mac = build(true).template;
    const win = build(false).template;
    expect(mac[0]?.label).toBe("Pi Desktop");
    expect(win[0]?.label).toBe("File");
  });
});
