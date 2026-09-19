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

  it("adds the macOS application menu only on darwin", () => {
    const mac = build(true).template;
    const win = build(false).template;
    expect(mac[0]?.label).toBe("Pi Desktop");
    expect(win[0]?.label).toBe("File");
  });
});
