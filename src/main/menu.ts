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
  { command: "open-file", label: "Open File…", accelerator: "CmdOrCtrl+P" },
  // Save/Format deliberately have no accelerator: the editor owns Mod-s and
  // Shift-Alt-F locally, and a menu accelerator would be consumed before the
  // renderer (swallowing Pi's selector/TUI Ctrl+S).
  { command: "save-editor", label: "Save File" },
  { command: "format-editor", label: "Format Document" },
  { command: "open-web-url", label: "Open URL in Tab…" },
  { command: "close-session", label: "Close Session", accelerator: "CmdOrCtrl+W" },
  { command: "view-sessions", label: "Sessions…", accelerator: "CmdOrCtrl+Alt+O" },
  { command: "view-settings", label: "Settings…", accelerator: "CmdOrCtrl+," },
];

const VIEW_ITEMS: readonly ItemSpec[] = [
  { command: "command-palette", label: "Command Palette…", accelerator: "CmdOrCtrl+K" },
  { command: "toggle-sidebar", label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B" },
  { command: "toggle-rail", label: "Toggle Panel", accelerator: "CmdOrCtrl+Shift+G" },
  { command: "next-tab", label: "Next Tab", accelerator: "Ctrl+Tab" },
  { command: "previous-tab", label: "Previous Tab", accelerator: "Ctrl+Shift+Tab" },
  // `CmdOrCtrl+=` is the chord users expect (Ctrl+= on Windows/Linux, Cmd+= on
  // macOS). Electron's `role: "zoomIn"` binds `Plus` instead, i.e. Shift+=,
  // which is why the old menu zoom appeared broken (electron#40674).
  { command: "zoom-in", label: "Zoom In", accelerator: "CmdOrCtrl+=" },
  { command: "zoom-out", label: "Zoom Out", accelerator: "CmdOrCtrl+-" },
  { command: "zoom-reset", label: "Actual Size", accelerator: "CmdOrCtrl+0" },
];

/**
 * The session view grid (2026-11-03 plan).
 *
 * Deliberately accelerator-free: the layout is chosen rarely, and a global chord
 * would fire before the renderer (that space belongs to Pi's own keys).
 */
const LAYOUT_ITEMS: readonly ItemSpec[] = [
  { command: "grid-single", label: "Layout: Single Tab" },
  { command: "grid-two", label: "Layout: Two Columns" },
  { command: "grid-three-left", label: "Layout: Three Panes (Left Tall)" },
  { command: "grid-three-right", label: "Layout: Three Panes (Right Tall)" },
  { command: "grid-four", label: "Layout: Four Panes" },
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
  { command: "view-explorer", label: "Explorer", accelerator: "CmdOrCtrl+Shift+E" },
  { command: "view-source-control", label: "Source Control" },
  { command: "view-checkpoints", label: "Checkpoints" },
  { command: "view-documents", label: "Documents" },
  { command: "view-extensions", label: "Extensions" },
  { command: "view-connections", label: "Connections" },
  { command: "view-skills", label: "Skills, Themes & Keys" },
  { command: "view-diagnostics", label: "Diagnostics" },
];

const HELP_ITEMS: readonly ItemSpec[] = [
  { command: "shortcuts", label: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+/" },
  // Opens Settings → About & updates and starts a check. A menu accelerator
  // here would only duplicate the status chip's own affordance.
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
      // The session view grid presets (2026-11-03 plan).
      ...toItems(LAYOUT_ITEMS, onCommand, accelerators),
      { type: "separator" },
      ...toItems(SESSION_ITEMS, onCommand, accelerators),
      { type: "separator" },
      { role: "reload" },
      { role: "toggleDevTools" },
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
      // macOS keeps the platform-native About panel; Windows/Linux get the
      // richer in-app card, which also carries the updater controls.
      ...(isMac
        ? []
        : [
            {
              id: "view-about",
              label: `About ${appName}`,
              click: () => onCommand("view-about"),
            },
          ]),
    ],
  });

  return template;
}

/** Installs the menu on the application (dynamic import keeps this file testable). */
export async function installAppMenu(deps: AppMenuDeps): Promise<void> {
  const { Menu } = await import("electron");
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(deps)));
}
