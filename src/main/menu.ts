import type { MenuItemConstructorOptions } from "electron";
import type { MenuCommand } from "../shared/ipc";

/**
 * The application menu (plan step 1).
 *
 * The menu is the app's discoverable command surface — it is where "New Session"
 * lives now (the placeholder UI's tab has nothing to do with it). Every item that
 * acts on the renderer sends a `MenuCommand` over `app:menu-command` instead of
 * touching windows directly, so the renderer stays the only owner of view state.
 *
 * `menuTemplate` is pure and `electron`-free (types only), so it is unit testable
 * in the node test project; `installAppMenu` performs the dynamic import.
 */

export interface AppMenuDeps {
  appName: string;
  isMac: boolean;
  onCommand: (command: MenuCommand) => void;
  onOpenExternal: (url: string) => void;
  /**
   * Accelerators resolved from the desktop keymap (session-parity plan step 23).
   * A `null` removes the accelerator for that command; a missing key keeps the
   * default. The menu is rebuilt when the prefs change.
   */
  accelerators?: Partial<Record<MenuCommand, string | null>>;
}

export const DOCS_URL = "https://github.com/earendil-works/pi";

interface ItemSpec {
  command: MenuCommand;
  label: string;
  accelerator?: string;
}

const FILE_ITEMS: readonly ItemSpec[] = [
  { command: "new-session", label: "New Session", accelerator: "CmdOrCtrl+N" },
  // `Ctrl+O` is Pi's `app.tools.expand` (plan step 18), so Open Project moves to
  // Shift+O; otherwise the menu accelerator would swallow the expand key before
  // the renderer ever sees it.
  { command: "open-project", label: "Open Project…", accelerator: "CmdOrCtrl+Shift+O" },
  { command: "open-web-url", label: "Open URL in Tab…" },
  { command: "close-session", label: "Close Session", accelerator: "CmdOrCtrl+W" },
  { command: "view-sessions", label: "Sessions…", accelerator: "CmdOrCtrl+Alt+O" },
  { command: "view-settings", label: "Settings…", accelerator: "CmdOrCtrl+," },
];

const VIEW_ITEMS: readonly ItemSpec[] = [
  { command: "command-palette", label: "Command Palette…", accelerator: "CmdOrCtrl+K" },
  { command: "toggle-sidebar", label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B" },
  { command: "next-tab", label: "Next Session Tab", accelerator: "Ctrl+Tab" },
  { command: "previous-tab", label: "Previous Session Tab", accelerator: "Ctrl+Shift+Tab" },
];

const SESSION_ITEMS: readonly ItemSpec[] = [
  { command: "session-tree", label: "Session History Tree…" },
  { command: "session-fork", label: "Fork From Message…" },
  { command: "session-export", label: "Export Session to HTML" },
  { command: "model-cycle-forward", label: "Next Model", accelerator: "CmdOrCtrl+Alt+Down" },
  { command: "model-cycle-backward", label: "Previous Model", accelerator: "CmdOrCtrl+Alt+Up" },
  { command: "thinking-cycle", label: "Cycle Thinking Level", accelerator: "CmdOrCtrl+Alt+T" },
];

const GO_ITEMS: readonly ItemSpec[] = [
  { command: "view-extensions", label: "Extensions" },
  { command: "view-connections", label: "Connections" },
  { command: "view-skills", label: "Skills, Themes & Keys" },
  { command: "view-diagnostics", label: "Diagnostics" },
];

const HELP_ITEMS: readonly ItemSpec[] = [
  { command: "shortcuts", label: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+/" },
  // The renderer runs the check and shows the result in the banner (plan step 26);
  // a menu accelerator here would only duplicate the banner's own button.
  { command: "check-updates", label: "Check for Updates…" },
];

function toItems(
  specs: readonly ItemSpec[],
  onCommand: (command: MenuCommand) => void,
  accelerators: Partial<Record<MenuCommand, string | null>> = {},
): MenuItemConstructorOptions[] {
  return specs.map((spec) => {
    const override = accelerators[spec.command];
    const accelerator = override === null ? undefined : (override ?? spec.accelerator);
    return {
      id: spec.command,
      label: spec.label,
      ...(accelerator ? { accelerator } : {}),
      click: () => {
        onCommand(spec.command);
      },
    };
  });
}

/**
 * Builds the menu template. Exported for tests: the ids and accelerators are the
 * contract the renderer's keyboard handling mirrors.
 */
export function menuTemplate(deps: AppMenuDeps): MenuItemConstructorOptions[] {
  const { appName, isMac, onCommand, onOpenExternal, accelerators = {} } = deps;

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push({
    label: "File",
    submenu: [
      ...toItems(FILE_ITEMS, onCommand, accelerators),
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit" },
    ],
  });

  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  });

  template.push({
    label: "View",
    submenu: [
      ...toItems(VIEW_ITEMS, onCommand, accelerators),
      { type: "separator" },
      ...toItems(SESSION_ITEMS, onCommand, accelerators),
      { type: "separator" },
      { role: "reload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  });

  template.push({ label: "Go", submenu: toItems(GO_ITEMS, onCommand) });

  // Pi for Office is an integration, not a primary surface (plan D-A10).
  template.push({
    label: "Integrations",
    submenu: [
      { id: "view-office", label: "Pi for Office…", click: () => onCommand("view-office") },
    ],
  });

  template.push({
    label: "Window",
    submenu: isMac
      ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
      : [{ role: "minimize" }, { role: "close" }],
  });

  template.push({
    label: "Help",
    submenu: [
      ...toItems(HELP_ITEMS, onCommand),
      {
        label: "Pi Documentation",
        click: () => onOpenExternal(DOCS_URL),
      },
      ...(isMac ? [] : ([{ label: `About ${appName}`, role: "about" }] as const)),
    ],
  });

  return template;
}

/** Installs the menu on the application (dynamic import keeps this file testable). */
export async function installAppMenu(deps: AppMenuDeps): Promise<void> {
  const { Menu } = await import("electron");
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(deps)));
}
